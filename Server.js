// UNO LAN server: serves uno.html and relays game messages (no internet needed).
// Run:  node server.js   then open the printed address on any device on your WiFi.
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const PORT=process.env.PORT||3000,rooms={},streams=new Set();
const sse=res=>{res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});res.write(':ok\n\n');streams.add(res);res.on('close',()=>streams.delete(res))};
const ev=(res,o)=>{if(res)res.write('data: '+JSON.stringify(o)+'\n\n')};
setInterval(()=>streams.forEach(r=>r.write(':hb\n\n')),20000);
http.createServer((req,res)=>{
 const u=new URL(req.url,'http://x'),q=u.searchParams;
 if(u.pathname=='/ping')return res.end('uno-relay');
 if(u.pathname=='/ev'){
  const room=q.get('room'),role=q.get('role'),id=q.get('id');sse(res);
  if(role=='host'){
   if(rooms[room]){ev(res,{t:'taken'});return res.end()}
   const r=rooms[room]={host:res,guests:{}};ev(res,{t:'ready'});
   res.on('close',()=>{Object.values(r.guests).forEach(g=>{ev(g,{t:'closed'});g.end()});if(rooms[room]===r)delete rooms[room]});return}
  const r=rooms[room];
  if(!r){ev(res,{t:'noroom'});return res.end()}
  r.guests[id]=res;ev(res,{t:'ready'});ev(r.host,{t:'join',id});
  res.on('close',()=>{delete r.guests[id];ev(r.host,{t:'left',id})});return}
 if(u.pathname=='/send'&&req.method=='POST'){
  let b='';req.on('data',d=>b+=d);
  req.on('end',()=>{const r=rooms[q.get('room')];if(r){let m;try{m=JSON.parse(b)}catch(e){return res.end('bad')}
   if(q.get('to')=='host')ev(r.host,{t:'msg',id:q.get('from'),m});else ev(r.guests[q.get('to')],{t:'msg',m})}res.end('ok')});return}
 fs.readFile(path.join(__dirname,'uno.html'),(e,d)=>{if(e){res.writeHead(500);return res.end('uno.html not found next to server.js')}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(d)});
}).listen(PORT,'0.0.0.0',()=>{
 console.log('\nUNO is running. Open on any device on the same WiFi:\n');
 Object.values(os.networkInterfaces()).flat().filter(i=>i.family=='IPv4'&&!i.internal).forEach(i=>console.log('   http://'+i.address+':'+PORT));
 console.log('\n   (this computer: http://localhost:'+PORT+')\n')});