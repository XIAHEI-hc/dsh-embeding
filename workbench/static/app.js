'use strict';
const $=id=>document.getElementById(id);
let token=sessionStorage.getItem('workbenchToken')||'', sid=null, selection=0, polling=false;
function notice(s){$('notice').textContent=s;$('notice').style.display='block';setTimeout(()=>$('notice').style.display='none',5000)}
async function api(path,options={}){
 const headers={Authorization:'Bearer '+token,...options.headers};
 if(options.body&&!(options.body instanceof FormData))headers['Content-Type']='application/json';
 const response=await fetch(path,{...options,headers});
 if(!response.ok){let detail;try{detail=(await response.json()).detail}catch{detail=response.statusText}throw new Error(typeof detail==='string'?detail:JSON.stringify(detail))}
 return response;
}
async function json(path,options){return (await api(path,options)).json()}
function guard(fn){return async(...args)=>{try{await fn(...args)}catch(e){notice(e.message)}}}
async function connect(){
 const health=await json('/api/health');
 $('health').textContent='SDK '+(health.sdk_version||'未安装')+' · '+health.model+(health.credential_configured?'':' · 未配置模型凭据');
 $('login').hidden=true;$('main').hidden=false;sessionStorage.setItem('workbenchToken',token);
 await sessions();
}
async function sessions(){const rows=await json('/api/sessions');$('sessions').replaceChildren();for(const r of rows){const b=document.createElement('button');b.textContent=r.title;b.classList.toggle('active',r.id===sid);b.onclick=guard(()=>select(r));$('sessions').append(b)}}
function message(role,text){const el=document.createElement('div');el.className='message '+role;const label=document.createElement('small');label.textContent=role==='user'?'你':'DSH';el.append(label,document.createTextNode(text));$('messages').append(el);$('messages').scrollTop=$('messages').scrollHeight}
async function history(current){const rows=await json('/api/sessions/'+current+'/runs');if(current!==sid)return;$('messages').replaceChildren();for(const r of rows){message('user',r.prompt);message('assistant',r.response||r.reason||'执行中…')}return rows}
async function select(r){sid=r.id;selection++;$('title').textContent=r.title;$('events').textContent='暂无事件';$('editor').value='';$('filePath').value='';await sessions();const rows=await history(sid);await files();const running=(rows||[]).find(r=>r.state==='running');if(running&&!polling)watch(running.id,sid).catch(e=>notice(e.message))}
async function files(){if(!sid)return;const current=sid,rows=await json('/api/sessions/'+current+'/files');if(current!==sid)return;$('files').replaceChildren();for(const f of rows){const b=document.createElement('button');b.textContent=f.path+' · '+f.size+' B';b.onclick=guard(async()=>{const data=await json('/api/sessions/'+current+'/file?path='+encodeURIComponent(f.path));if(current!==sid)return;$('filePath').value=data.path;$('editor').value=data.text});$('files').append(b)}}
async function watch(rid,current){
 polling=true;$('send').disabled=true;let after=0,lines=[];
 try{while(true){
  const events=await json('/api/runs/'+rid+'/events?after='+after);
  for(const e of events){after=e.id;lines.push(JSON.stringify({kind:e.kind,...e.payload}));if(lines.length>300)lines.shift()}
  if(current===sid){$('events').textContent=lines.join('\n');$('events').scrollTop=$('events').scrollHeight}
  const run=await json('/api/runs/'+rid);
  if(current===sid)$('state').textContent=run.state;
  if(run.state!=='running'&&events.length<200){if(current===sid){await history(current);await files()}break}
  await new Promise(resolve=>setTimeout(resolve,900));
 }}finally{polling=false;$('send').disabled=false}
}
$('connect').onclick=guard(async()=>{token=$('token').value.trim();await connect()});
$('logout').onclick=()=>{sessionStorage.removeItem('workbenchToken');location.reload()};
$('new').onclick=guard(async()=>{const title=prompt('会话名称','新会话');if(!title)return;await select(await json('/api/sessions',{method:'POST',body:JSON.stringify({title})}))});
$('composer').onsubmit=guard(async event=>{event.preventDefault();if(!sid)throw new Error('请先创建会话');const current=sid,text=$('prompt').value.trim();if(!text)return;const r=await json('/api/sessions/'+current+'/runs',{method:'POST',body:JSON.stringify({prompt:text})});$('prompt').value='';message('user',text);await watch(r.id,current)});
$('refreshFiles').onclick=guard(files);
$('upload').onchange=guard(async()=>{if(!sid)throw new Error('请先创建会话');const file=$('upload').files[0];if(!file)return;const data=new FormData();data.append('file',file);await json('/api/sessions/'+sid+'/files',{method:'POST',body:data});$('upload').value='';await files();notice('文件已上传')});
$('save').onclick=guard(async()=>{if(!sid)throw new Error('请先创建会话');const data=await json('/api/sessions/'+sid+'/files',{method:'PUT',body:JSON.stringify({path:$('filePath').value,text:$('editor').value})});$('diff').textContent=data.diff;await files();notice('修改已保存')});
$('download').onclick=guard(async()=>{if(!sid||!$('filePath').value)throw new Error('请选择文件');const path=$('filePath').value,response=await api('/api/sessions/'+sid+'/download?path='+encodeURIComponent(path));const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=path.split('/').pop();a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
if(token)connect().catch(e=>{$('loginError').textContent=e.message;sessionStorage.removeItem('workbenchToken')});
