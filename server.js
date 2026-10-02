import http from 'node:http';

const PORT=process.env.PORT||3000;
const state=new Map();
let lastScan=process.env.RADAR_LAST_SCAN||new Date(Date.now()-10*60*1000).toISOString();

const DEFAULT={
 keywords:['台北 美髮','台北 髮廊','台北 剪髮'],
 intentKeywords:['推薦','有推薦','求推薦','請問哪家','哪間','想找','想做','預約'],
 locationKeywords:['台北','北市','松山','中山','大安','信義'],
 serviceKeywords:['美髮','髮廊','剪髮','染髮','燙髮','護髮','短髮'],
 lowIntentKeywords:['有人做過嗎','好奇','隨便問','分享一下'],
 minScore:35
};

const json=(v,d)=>{try{return v?JSON.parse(v):d}catch{return d}};
const cfg=()=>json(process.env.RADAR_CONFIG_JSON,DEFAULT);
const businesses=()=>json(process.env.BUSINESSES_JSON,[{name:'TEST_BUSINESS',area:'台北',primaryService:'美髮',webhookUrl:''}]);
const norm=s=>(s||'').toLowerCase().replace(/\\s+/g,' ').trim();

function score(p,c){
 const t=norm(p.text), reasons=[]; let n=0;
 for(const k of c.intentKeywords||[])if(t.includes(norm(k))){n+=20;reasons.push('需求詞:'+k)}
 for(const k of c.locationKeywords||[])if(t.includes(norm(k))){n+=20;reasons.push('地區:'+k)}
 for(const k of c.serviceKeywords||[])if(t.includes(norm(k))){n+=15;reasons.push('服務:'+k)}
 for(const k of c.lowIntentKeywords||[])if(t.includes(norm(k))){n-=20;reasons.push('低意圖:'+k)}
 if(p.is_reply){n+=5;reasons.push('回覆串內需求')}
 return{score:n,reasons};
}
function draft(b){return `如果你找的是${b.area||'台北'}的${b.primaryService||'服務'}，可以看看 ${b.name}。我們最近也蠻常做這類需求，作品/案例可以先給你參考～`}

async function searchThreads(keyword,since){
 if(!process.env.THREADS_ACCESS_TOKEN)throw Error('Missing THREADS_ACCESS_TOKEN');
 const u=new URL('https://graph.threads.com/v1.0/keyword_search');
 u.searchParams.set('q',keyword);u.searchParams.set('search_type','RECENT');u.searchParams.set('search_mode','KEYWORD');
 u.searchParams.set('fields','id,text,media_type,permalink,timestamp,username,has_replies,is_quote_post,is_reply');
 u.searchParams.set('limit','50');u.searchParams.set('since',Math.floor(new Date(since).getTime()/1000));u.searchParams.set('access_token',process.env.THREADS_ACCESS_TOKEN);
 const r=await fetch(u),body=await r.text();if(!r.ok)throw Error('Threads search '+r.status+': '+body);return JSON.parse(body);
}
async function alert(lead,b){
 if(!b.webhookUrl)return{sent:false,reason:'no webhookUrl'};
 const r=await fetch(b.webhookUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'new_threads_lead',business:b.name,lead,suggested_reply:draft(b),note:'目前只通知，不會自動留言。'})});
 return{sent:r.ok,status:r.status};
}
async function scan(){
 const c=cfg(), bs=businesses(), since=lastScan, out=[], seen=new Set();
 for(const k of c.keywords){
  const d=await searchThreads(k,since);
  for(const p of d.data||[]){
   if(!p.id||seen.has(p.id)||state.has(p.id))continue;seen.add(p.id);
   const s=score(p,c);if(s.score<c.minScore)continue;
   for(const b of bs){
    const x=score(p,{intentKeywords:b.intentKeywords||c.intentKeywords,locationKeywords:b.locationKeywords||[b.area||'台北'],serviceKeywords:b.serviceKeywords||[b.primaryService||''],lowIntentKeywords:c.lowIntentKeywords});
    if(x.score>=(b.minScore??c.minScore)){const a=await alert({score:x.score,reasons:x.reasons,post:p},b);out.push({business:b.name,postId:p.id,score:x.score,alerted:a.sent})}
   }
   state.set(p.id,Date.now());
  }
 }
 lastScan=new Date().toISOString();
 for(const [id,t] of state)if(Date.now()-t>30*86400000)state.delete(id);
 return{scannedAt:lastScan,since,results:out};
}

const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');
 res.setHeader('content-type','application/json');
 if(u.pathname==='/health')return res.end(JSON.stringify({ok:true,service:'threads-demand-radar'}));
 if(u.pathname==='/scan'&&req.method==='POST'){
  try{return res.end(JSON.stringify(await scan()))}catch(e){res.statusCode=500;return res.end(JSON.stringify({ok:false,error:String(e.message||e)}))}
 }
 res.statusCode=404;res.end(JSON.stringify({error:'not found'}));
});
server.listen(PORT,()=>console.log('Threads Demand Radar listening on '+PORT));

const interval=Number(process.env.SCAN_INTERVAL_MS||300000);
setInterval(()=>scan().then(r=>console.log(JSON.stringify(r))).catch(e=>console.error(e)),interval);
