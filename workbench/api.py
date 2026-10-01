import secrets
from contextlib import asynccontextmanager
from importlib.metadata import version, PackageNotFoundError
from pathlib import Path
from fastapi import FastAPI, Depends, Header, HTTPException, UploadFile, File, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from .config import Settings
from .service import Workbench, MAX_FILE

class SessionRequest(BaseModel):
    title: str = Field(default='新会话', min_length=1, max_length=100)
class PromptRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=50000)
class TextRequest(BaseModel):
    path: str
    text: str = Field(max_length=MAX_FILE)

def create_app(settings=None, factory=None):
    cfg = settings or Settings.load()
    if len(cfg.token) < 24:
        raise RuntimeError('WORKBENCH_TOKEN 至少需要 24 个字符，请参照 README 生成')
    service = Workbench(cfg, factory) if factory else Workbench(cfg)
    @asynccontextmanager
    async def lifespan(app):
        yield
        import asyncio
        await asyncio.to_thread(service.shutdown)
    app = FastAPI(title='DSH Workbench', lifespan=lifespan)
    app.state.service = service
    def auth(authorization: str = Header(default='')):
        if not secrets.compare_digest(authorization, 'Bearer ' + cfg.token):
            raise HTTPException(401, '工作台访问令牌无效')
    @app.exception_handler(KeyError)
    async def missing(request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse({'detail':str(exc)},status_code=404)
    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse({'detail':str(exc)},status_code=409 if '执行' in str(exc) else 400)
    @app.get('/api/health', dependencies=[Depends(auth)])
    def health():
        try: sdk = version('deepseek-harness-sdk')
        except PackageNotFoundError: sdk = None
        return {'sdk_version':sdk,'model':cfg.model,'profile':cfg.profile,'credential_configured':bool(cfg.api_key),'active_session':service.active,'runtime_cleanup_failed':service.poisoned}
    @app.get('/api/sessions', dependencies=[Depends(auth)])
    def sessions(): return service.store.sessions()
    @app.post('/api/sessions', dependencies=[Depends(auth)])
    def session(body: SessionRequest): return service.store.create_session(body.title)
    @app.get('/api/sessions/{sid}/runs', dependencies=[Depends(auth)])
    def runs(sid: str):
        service.store.require_session(sid)
        return service.store.runs(sid)
    @app.post('/api/sessions/{sid}/runs', dependencies=[Depends(auth)])
    def run(sid: str, body: PromptRequest):
        return {'id':service.start(sid, body.prompt)}
    @app.get('/api/runs/{rid}', dependencies=[Depends(auth)])
    def status(rid: str): return service.store.run(rid)
    @app.get('/api/runs/{rid}/events', dependencies=[Depends(auth)])
    def events(rid: str, after: int = Query(default=0, ge=0)):
        service.store.run(rid)
        return service.store.events(rid, after)
    @app.get('/api/sessions/{sid}/files', dependencies=[Depends(auth)])
    def files(sid: str): return service.files(sid)
    @app.post('/api/sessions/{sid}/files', dependencies=[Depends(auth)])
    async def upload(sid: str, file: UploadFile = File(...)):
        name = file.filename or ''
        if not name or '/' in name or '\\' in name: raise HTTPException(400,'文件名不合法')
        data = await file.read(MAX_FILE+1)
        return {'diff':service.write(sid, 'input/'+name, data)}
    @app.put('/api/sessions/{sid}/files', dependencies=[Depends(auth)])
    def edit(sid: str, body: TextRequest):
        return {'diff':service.write(sid, body.path, body.text.encode())}
    @app.get('/api/sessions/{sid}/file', dependencies=[Depends(auth)])
    def read(sid: str, path: str):
        p = service.path(sid,path)
        if not p.is_file(): raise HTTPException(404,'文件不存在')
        if p.stat().st_size > MAX_FILE: raise HTTPException(413,'文本预览最大 10 MB')
        try: text = p.read_text(encoding='utf-8')
        except UnicodeDecodeError: raise HTTPException(415,'二进制文件请下载查看')
        return {'path':path,'text':text}
    @app.get('/api/sessions/{sid}/download', dependencies=[Depends(auth)])
    def download(sid: str, path: str):
        p = service.path(sid,path)
        if not p.is_file(): raise HTTPException(404,'文件不存在')
        return FileResponse(p,filename=p.name,media_type='application/octet-stream')
    @app.middleware('http')
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"
        return response
    app.mount('/', StaticFiles(directory=Path(__file__).parent/'static',html=True), name='ui')
    return app
