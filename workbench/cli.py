import argparse
import json
import sys
from .config import Settings
from .service import Workbench

def main():
    p = argparse.ArgumentParser(description='DSH 独立工作台')
    sub = p.add_subparsers(dest='command',required=True)
    web = sub.add_parser('web', help='启动独立网页')
    web.add_argument('--host',default='127.0.0.1')
    web.add_argument('--port',type=int,default=8765)
    web.add_argument('--reload',action='store_true')
    chat = sub.add_parser('chat',help='命令行任务或交互对话')
    chat.add_argument('prompt',nargs='?')
    chat.add_argument('--session',help='复用已有会话 ID')
    sub.add_parser('doctor',help='检查 SDK 和配置，不调用模型')
    sub.add_parser('sessions',help='列出会话')
    args = p.parse_args()
    settings = Settings.load()
    if args.command == 'web':
        import uvicorn
        uvicorn.run('workbench.api:create_app',factory=True,host=args.host,port=args.port,reload=args.reload)
        return
    if args.command == 'doctor':
        import importlib.metadata
        try:
            sdk = importlib.metadata.version('deepseek-harness-sdk')
            runtime = importlib.metadata.version('deepseek-harness-runtime-bin')
        except importlib.metadata.PackageNotFoundError as e:
            print('缺少依赖:',e); sys.exit(1)
        print(json.dumps({'sdk':sdk,'runtime':runtime,'model':settings.model,'profile':settings.profile,
                          'api_key_configured':bool(settings.api_key),'web_token_valid':len(settings.token)>=24,
                          'data_dir':str(settings.data_dir)},ensure_ascii=False,indent=2))
        return
    app = Workbench(settings)
    if args.command == 'sessions':
        print(json.dumps(app.store.sessions(),ensure_ascii=False,indent=2)); return
    sid = args.session or app.store.create_session()['id']
    app.store.require_session(sid)
    print('会话:',sid,'\n工作目录:',app.store.workspace(sid))
    def run(prompt):
        rid = app.start(sid,prompt,background=False)
        result = app.store.run(rid)
        print(result['response'] or result['reason'])
        print('状态:',result['state'])
        return result['state'] == 'completed'
    if args.prompt:
        if not run(args.prompt): sys.exit(1)
    else:
        while True:
            try: prompt = input('\n你> ')
            except (EOFError,KeyboardInterrupt): break
            if prompt.strip() in ('/exit','/quit'): break
            if prompt.strip(): run(prompt)

if __name__ == '__main__': main()
