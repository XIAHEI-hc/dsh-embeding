import threading
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from workbench.api import create_app
from workbench.config import Settings
from workbench.service import Workbench

TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz'
@pytest.fixture
def cfg(tmp_path):
    return Settings(tmp_path,TOKEN,'test-key','https://api.deepseek.com','deepseek-v4-flash','sdk')

class FakeRuntime:
    def __init__(self,cfg,workspace,home): self.workspace=workspace
    def run(self,prompt,sid,notify):
        notify({'method':'session.event','payload':{'sessionId':sid,'event':{'type':'tool/result','data':{'text':'test-key'}}}})
        (self.workspace/'output').mkdir(exist_ok=True)
        (self.workspace/'output/report.txt').write_text('result')
        return SimpleNamespace(final_response='done',finish_reason='completed')
    def close(self): pass

@pytest.fixture
def client(cfg):
    with TestClient(create_app(cfg,FakeRuntime)) as c:
        c.headers['Authorization']='Bearer '+TOKEN
        yield c

def test_auth_and_configuration(client):
    assert client.get('/api/health',headers={'Authorization':''}).status_code==401
    assert client.get('/api/health').json()['credential_configured']
    assert client.get('/').headers['content-security-policy'].endswith("frame-ancestors 'none'")

def test_full_workflow_and_replay(client):
    sid=client.post('/api/sessions',json={'title':'analysis'}).json()['id']
    assert client.post(f'/api/sessions/{sid}/files',files={'file':('sample.csv',b'x,y\n1,2\n')}).status_code==200
    assert client.put(f'/api/sessions/{sid}/files',json={'path':'scripts/a.py','text':'print(1)\n'}).status_code==200
    rid=client.post(f'/api/sessions/{sid}/runs',json={'prompt':'analyze'}).json()['id']
    client.app.state.service.worker.join(5)
    run=client.get('/api/runs/'+rid).json()
    assert run['state']=='completed' and run['response']=='done'
    events=client.get(f'/api/runs/{rid}/events').json()
    assert 'test-key' not in str(events)
    assert client.get(f'/api/runs/{rid}/events?after='+str(events[-1]['id'])).json()==[]
    assert client.get(f'/api/sessions/{sid}/download?path=output/report.txt').content==b'result'
    assert len(client.get(f'/api/sessions/{sid}/runs').json())==1
    service=client.app.state.service
    restored=Workbench(service.settings,FakeRuntime)
    assert restored.store.runs(sid)[0]['state']=='completed'

def test_traversal_and_symlink_rejected(client):
    sid=client.post('/api/sessions',json={}).json()['id']
    for p in ('../escape','/tmp/escape','input/../../escape','dsh-home/settings'):
        assert client.put(f'/api/sessions/{sid}/files',json={'path':p,'text':'x'}).status_code==400
    root=client.app.state.service.store.workspace(sid)
    (root/'input').mkdir(); (root/'input/link').symlink_to(root.parent)
    assert client.put(f'/api/sessions/{sid}/files',json={'path':'input/link/pwn','text':'x'}).status_code==400
    assert client.get('/api/runs/not-found/events').status_code==404

def test_concurrency_and_file_mutation(cfg):
    entered=threading.Event(); release=threading.Event()
    class Blocking(FakeRuntime):
        def run(self,*a):
            entered.set(); release.wait(5)
            return SimpleNamespace(final_response='done',finish_reason='completed')
    s=Workbench(cfg,Blocking); sid=s.store.create_session()['id']; rid=s.start(sid,'first'); assert entered.wait(2)
    try:
        with pytest.raises(ValueError,match='执行'): s.start(sid,'second')
        with pytest.raises(ValueError,match='执行'): s.write(sid,'input/a.txt',b'no')
    finally: release.set(); s.worker.join(5)
    assert s.store.run(rid)['state']=='completed'

def test_error_cleanup_and_recovery(cfg):
    class Failing(FakeRuntime):
        closed=False
        def run(self,*a): raise RuntimeError('test-key network unavailable')
        def close(self): Failing.closed=True
    s=Workbench(cfg,Failing);sid=s.store.create_session()['id'];rid=s.start(sid,'x',False)
    assert s.store.run(rid)['state']=='failed' and Failing.closed
    assert 'test-key' not in str(s.store.run(rid))
    s.factory=FakeRuntime
    assert s.store.run(s.start(sid,'retry',False))['state']=='completed'

def test_missing_credentials_and_restart(cfg):
    cfg.api_key=''
    s=Workbench(cfg);sid=s.store.create_session()['id'];rid=s.start(sid,'hi',False)
    assert s.store.run(rid)['state']=='failed'
    assert 'DEEPSEEK_API_KEY' in s.store.run(rid)['reason']
    rid=s.store.new_run(sid,'abandoned')
    restored=Workbench(cfg)
    assert restored.store.run(rid)['state']=='interrupted'

def test_partial_result_is_not_success(cfg):
    class Partial(FakeRuntime):
        def run(self,*a): return SimpleNamespace(final_response='partial',finish_reason='max-tokens')
    s=Workbench(cfg,Partial);sid=s.store.create_session()['id']
    assert s.store.run(s.start(sid,'hi',False))['state']=='incomplete'

def test_sdk_adapter_matches_installed_contract(cfg,tmp_path):
    from workbench.runtime import OfficialRuntime
    r=OfficialRuntime(cfg,tmp_path,tmp_path/'home')
    assert r.harness.config.profile=='sdk'
    assert r.harness.config.request_timeout_seconds==900
    r.close()

def test_failed_shutdown_blocks_subsequent_runtime(cfg):
    class BadClose(FakeRuntime):
        def close(self): raise RuntimeError('cannot reap')
    s=Workbench(cfg,BadClose);sid=s.store.create_session()['id'];s.start(sid,'hi',False)
    assert s.poisoned
    with pytest.raises(ValueError,match='关闭失败'):s.start(sid,'retry')
