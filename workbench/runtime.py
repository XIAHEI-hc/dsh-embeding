from dataclasses import asdict, is_dataclass
from pathlib import Path
from .config import Settings

class OfficialRuntime:
    def __init__(self, settings: Settings, workspace: Path, home: Path):
        if not settings.api_key:
            raise RuntimeError('请先在 .env 配置 DEEPSEEK_API_KEY')
        from deepseek_harness import DeepSeekHarness
        home.mkdir(parents=True, exist_ok=True)
        self.harness = DeepSeekHarness(
            dsh_home=str(home), cwd=str(workspace), runtime_cwd=str(workspace),
            provider='deepseek-official', model=settings.model, profile=settings.profile,
            patches=settings.patches, api_key=settings.api_key, base_url=settings.base_url,
            initialize_timeout_seconds=30, request_timeout_seconds=settings.timeout,
        )

    def run(self, prompt, sid, notify):
        def callback(n):
            payload = asdict(n) if is_dataclass(n) else {'method': n.method, 'payload': n.payload}
            notify(payload)
        return self.harness.run(prompt, session_id=sid, on_notification=callback)

    def close(self):
        self.harness.close()
