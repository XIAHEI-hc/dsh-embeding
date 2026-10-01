import difflib
import json
import threading
from pathlib import Path
from .runtime import OfficialRuntime
from .store import Store

MAX_FILE = 10 * 1024 * 1024

class Workbench:
    def __init__(self, settings, factory=OfficialRuntime):
        self.settings = settings
        self.store = Store(settings.data_dir)
        self.factory = factory
        # v1 deliberately has one active runtime, matching its single-user deployment.
        self.gate = threading.Lock()
        self.file_lock = threading.Lock()
        self.active = None
        self.worker = None
        self.poisoned = False

    def start(self, sid, prompt, background=True):
        self.store.require_session(sid)
        if self.poisoned: raise ValueError('上次运行时关闭失败，请重启服务并检查残留进程')
        if not prompt.strip(): raise ValueError('请输入任务内容')
        with self.file_lock:
            if not self.gate.acquire(blocking=False): raise ValueError('已有任务正在执行，请等待完成')
            try:
                rid = self.store.new_run(sid, prompt)
                self.active = sid
            except Exception:
                self.gate.release()
                raise
        if background:
            self.worker = threading.Thread(target=self.execute, args=(sid, rid, prompt), daemon=True)
            self.worker.start()
        else:
            self.execute(sid, rid, prompt)
        return rid

    def execute(self, sid, rid, prompt):
        runtime = None
        try:
            workspace = self.store.workspace(sid)
            runtime = self.factory(self.settings, workspace, workspace.parent / 'dsh-home')
            self.store.event(rid, 'started', {'session_id': sid})
            instruction = ('请在当前工作目录处理任务。上传的文件在 input/，新产物写到 output/，脚本可写到 scripts/。'
                           '不要修改工作目录之外的文件。解释执行结果并列出产物路径。\n\n用户任务：\n')
            def notify(n):
                encoded = json.dumps(n, ensure_ascii=False)
                for secret in (self.settings.api_key, self.settings.token):
                    if secret: encoded = encoded.replace(secret, '[REDACTED]')
                self.store.event(rid, 'sdk', json.loads(encoded))
            result = runtime.run(instruction + prompt, sid, notify)
            reason = result.finish_reason
            state = 'completed' if reason == 'completed' else 'incomplete'
            if reason == 'error': state = 'failed'
            self.store.finish(rid, state, result.final_response, reason)
            self.store.event(rid, 'finished', {'state':state, 'finish_reason':reason})
        except Exception as e:
            # Redact credentials from SDK diagnostics before persistence / presentation.
            message = str(e)
            if self.settings.api_key: message = message.replace(self.settings.api_key, '[REDACTED]')
            if self.settings.token: message = message.replace(self.settings.token, '[REDACTED]')
            self.store.finish(rid, 'failed', reason=message)
            self.store.event(rid, 'error', {'message':message})
        finally:
            try:
                if runtime is not None: runtime.close()
            except Exception:
                self.poisoned = True
                self.store.event(rid, 'cleanup_error', {'message':'运行时关闭失败，请检查服务器日志及残留进程'})
            finally:
                self.active = None
                self.gate.release()

    def path(self, sid, name):
        self.store.require_session(sid)
        root = self.store.workspace(sid).resolve()
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or not relative.parts:
            raise ValueError('文件路径不合法')
        if relative.parts[0] not in ('input', 'output', 'scripts'):
            raise ValueError('文件必须位于 input/、output/ 或 scripts/ 下')
        p = root / relative
        for part in [p, *p.parents]:
            if part == root: break
            if part.is_symlink(): raise ValueError('不允许访问符号链接')
        if not p.resolve().is_relative_to(root): raise ValueError('文件路径越界')
        return p

    def files(self, sid):
        self.store.require_session(sid)
        root = self.store.workspace(sid)
        out = []
        for folder in ('input','output','scripts'):
            base = root / folder
            if not base.exists() or base.is_symlink(): continue
            for p in base.rglob('*'):
                if len(out) >= 1000: break
                try:
                    self.path(sid, p.relative_to(root).as_posix())
                    if p.is_file(): out.append({'path':p.relative_to(root).as_posix(),'size':p.stat().st_size})
                except (ValueError, OSError): continue
        return out

    def write(self, sid, name, data):
        if len(data) > MAX_FILE: raise ValueError('文件超过 10 MB 限制')
        with self.file_lock:
            if self.active is not None: raise ValueError('执行期间不能修改文件')
            p = self.path(sid, name)
            before = p.read_bytes() if p.exists() and p.stat().st_size <= MAX_FILE else b''
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        try:
            return ''.join(difflib.unified_diff(before.decode().splitlines(True),data.decode().splitlines(True),fromfile='before',tofile='after'))
        except UnicodeDecodeError: return '二进制文件已保存'

    def shutdown(self):
        if self.worker and self.worker.is_alive():
            self.worker.join(timeout=self.settings.timeout + 35)
