import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { Bot, Download, Play, RefreshCcw, ShieldAlert, UploadCloud, ChevronRight } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, Sankey, ScatterChart, Scatter } from "recharts";

/** See README for column mapping. This is the compact version. */

type TopProviderRow = { name: string; billed: number; allowed: number; claims: number; denied: number; umMismatch: number; cycleAvg: number };

type Claim = {
  serviceDate: string;
  svcFrom: string;
  svcThru: string;
  claimId: string;
  itmcd: string;
  seqno: number;
  entryDate: string;
  completedDate: string;
  cycleDays: number | null;
  payAction: string;
  denied: boolean;
  billed: number;
  allowed: number;
  paidProxy: number;
  lppInit: number;
  umCase: string;
  umMatch: "MATCH" | "NO MATCH" | "MULTI MATCH" | "USERNOMATCH" | "<100% MATCH" | "OTHER" | "";
  provider: string;
  region: string;
  company: string;
  reason: string;
  diagPrimary: string;
  diag: string;
  proc: string;
  discharge: string;
  los: number;
  expLos: number;
  dischargeGap: boolean;
  stopLoss: boolean;
  serviceLine: string;
};

type Msg = { id: string; role: "user" | "assistant"; text: string; node?: React.ReactNode; csv?: string; followUpQuestions?: string[] };
type TraceItem = { id: string; kind: "think" | "tool"; name: string; status: "running" | "done"; detail?: string };

const NL = String.fromCharCode(10);

function uid() {
  const anyCrypto: any = (globalThis as any).crypto;
  return anyCrypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function usd(n: number) { return Number.isFinite(n) ? n.toLocaleString(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}) : "–"; }
function pct(x: number) { return Number.isFinite(x) ? `${(x*100).toFixed(1)}%` : "–"; }
function nfmt(n: number) { return Number.isFinite(n) ? Math.round(n).toLocaleString() : "–"; }
function safeStr(v: any) { return String(v ?? "").trim(); }
function num(v: any) { const s = safeStr(v).replace(/[$,]/g,""); const n = typeof v === "number" ? v : Number(s); return Number.isFinite(n) ? n : 0; }
function groupBy<T>(arr: T[], keyFn: (t: T) => string) { const m=new Map<string,T[]>(); for(const it of arr){const k=keyFn(it); (m.get(k)??m.set(k,[]).get(k)!).push(it);} return m; }
function toCSV(rows: { [k: string]: any }[]) { if(!rows.length) return ""; const headers=Object.keys(rows[0]); const esc=(v:any)=>JSON.stringify(v??""); return [headers.join(","),...rows.map(r=>headers.map(h=>esc(r[h])).join(","))].join(NL); }
function downloadCSV(filename: string, text: string) { const blob=new Blob([text],{type:"text/csv;charset=utf-8"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }

function looksLikeYYYYMMDD(s: string) { return /^[0-9]{8}$/.test(s); }
function toIsoDate(v:any):string{
  if(v==null||v==="") return "";
  if(v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0,10);
  if(typeof v==="number" && isFinite(v) && v>20000 && v<90000){ const d=XLSX.SSF.parse_date_code(v); if(d) return new Date(Date.UTC(d.y,d.m-1,d.d)).toISOString().slice(0,10); }
  const s=safeStr(v); const dt=new Date(s); if(!isNaN(dt.getTime())) return dt.toISOString().slice(0,10);
  if(looksLikeYYYYMMDD(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return "";
}
function parseSeqno(v:any){ const n=num(v); return Number.isFinite(n)&&n>0?Math.round(n):999; }
function isDenied(payAct:string){ return safeStr(payAct).toUpperCase().startsWith("R"); }
function daysBetween(aIso:string,bIso:string){ if(!aIso||!bIso) return null; const a=new Date(`${aIso}T00:00:00Z`); const b=new Date(`${bIso}T00:00:00Z`); if(isNaN(a.getTime())||isNaN(b.getTime())) return null; return Math.round((b.getTime()-a.getTime())/86400000); }
function losFromDates(fromIso:string,thruIso:string){ if(!fromIso&&!thruIso) return 1; const f=new Date(`${(fromIso||thruIso)}T00:00:00Z`); const t=new Date(`${(thruIso||fromIso)}T00:00:00Z`); if(isNaN(f.getTime())||isNaN(t.getTime())) return 1; return Math.max(1,Math.round((t.getTime()-f.getTime())/86400000)+1); }
function inferServiceLine(row:any){ const t=`${safeStr(row.REASON)} ${safeStr(row.DDC_NAT_E00_DIAG_CODE)} ${safeStr(row.DDC_CD_ICDA_CDE_1)} ${safeStr(row.DDC_NAT_E00_PROC_CODE)}`.toLowerCase(); if(t.includes("sepsis")) return "Sepsis"; if(t.includes("onc")||t.includes("cancer")||t.includes("chemo")||t.includes("tumor")) return "Oncology"; if(t.includes("neo")||t.includes("nicu")||t.includes("neon")) return "NICU"; return "Other"; }
function umMatchBucket(umCase:string):Claim["umMatch"]{ const u=safeStr(umCase).toUpperCase(); if(!u) return ""; if(u.includes("NO MATCH")) return "NO MATCH"; if(u.includes("MULTI MATCH")) return "MULTI MATCH"; if(u.includes("USERNOMATCH")) return "USERNOMATCH"; if(u.includes("<100% MATCH")) return "<100% MATCH"; if(u.includes("MATCH")) return "MATCH"; return "OTHER"; }
function selectLatestAdjustments(rows:any[]){ const withDcn=rows.filter(r=>!!safeStr(r.DCN)); const noDcn=rows.filter(r=>!safeStr(r.DCN)); const by=groupBy(withDcn,r=>safeStr(r.DCN)); const out:any[]=[]; for(const [,list] of by.entries()){ let best=list[0]; let bestSeq=parseSeqno(best.SEQNO); for(const r of list){ const s=parseSeqno(r.SEQNO); if(s<bestSeq){ best=r; bestSeq=s; } } out.push(best); } return [...out,...noDcn]; }
function expectedLosByServiceLine(claims:Claim[]){ const by=groupBy(claims,c=>c.serviceLine); const out:Record<string,number>={}; for(const [k,list] of by.entries()){ const vals=list.map(x=>x.los).filter(n=>n>0).sort((a,b)=>a-b); const med=vals.length?vals[Math.floor(vals.length/2)]:5; out[k]=Math.max(1,Math.round(med)); } return out; }

function mapExcelRowsToClaims(rows:any[]):Claim[]{
  const deduped=selectLatestAdjustments(rows);
  const tmp:Claim[]=deduped.map((r,idx)=>{
    const claimId=safeStr(r.DCN)||`ROW-${idx+1}`;
    const itmcd=safeStr(r.ITMCD);
    const seqno=parseSeqno(r.SEQNO);
    const svcFrom=toIsoDate(r.DDC_CD_SVC_FROM_DTE ?? r.DDC_CD_SVC_THRU_DTE);
    const svcThru=toIsoDate(r.DDC_CD_SVC_THRU_DTE ?? r.DDC_CD_SVC_FROM_DTE);
    const serviceDate=svcFrom||svcThru||"";
    const entryDate=toIsoDate(r.DDC_CD_ORIG_ENTRY_DTE);
    const completedDate=toIsoDate(r.DDC_CD_CLM_COMPL_DTE);
    const cycleDays=daysBetween(entryDate,completedDate);
    const payAction=safeStr(r.PAY_ACT_CD);
    const denied=isDenied(payAction);
    const billed=num(r.DDC_CD_TOT_CHRG_AMT);
    const allowed=num(r.DDC_CD_TOT_BNFT_AMT);
    const paidProxy=denied?0:allowed;
    const lppInit=num(r.DDC_CD_LPP_INT_AMT);
    const umCase=safeStr(r.DDC_NAT_E00_CAS_NBR);
    const umMatch=umMatchBucket(umCase);
    const provider=safeStr(r.DDC_CD_PRVDR_NME)||safeStr(r.DDC_CD_PRVDR_TAX_ID)||"Unknown Provider";
    const region=safeStr(r.DDC_CD_GRP_STATE)||"Unknown";
    const company=safeStr(r.DDC_CD_COMPANY_CDE);
    const reason=safeStr(r.REASON);
    const diagPrimary=safeStr(r.DDC_CD_ICDA_CDE_1);
    const diag=safeStr(r.DDC_NAT_E00_DIAG_CODE)||diagPrimary;
    const proc=safeStr(r.DDC_NAT_E00_PROC_CODE);
    const discharge=safeStr(r.DDC_NAT_E00_DISCHARGE_CODE);
    const los=losFromDates(svcFrom,svcThru);
    const expLos=5;
    const serviceLine=inferServiceLine(r);
    const stopLoss=allowed>=150000;
    const dischargeGap=los-expLos>=3;
    return {serviceDate,svcFrom,svcThru,claimId,itmcd,seqno,entryDate,completedDate,cycleDays,payAction,denied,billed,allowed,paidProxy,lppInit,umCase,umMatch,provider,region,company,reason,diagPrimary,diag,proc,discharge,los,expLos,dischargeGap,stopLoss,serviceLine};
  }).filter(c=>!!c.serviceDate);

  const med=expectedLosByServiceLine(tmp);
  return tmp.map(c=>{ const expLos=med[c.serviceLine]??5; const dischargeGap=c.los-expLos>=3; return {...c,expLos,dischargeGap}; });
}

async function readXlsxFromArrayBuffer(buf:ArrayBuffer):Promise<Claim[]>{
  const wb=XLSX.read(buf,{type:"array"});
  const sheetName=wb.SheetNames[0];
  const ws=wb.Sheets[sheetName];
  const rows=XLSX.utils.sheet_to_json(ws,{defval:"",raw:true}) as any[];
  return mapExcelRowsToClaims(rows);
}
async function readXlsxFromFile(file:File){ return readXlsxFromArrayBuffer(await file.arrayBuffer()); }
async function readXlsxFromUrl(url:string){ const res=await fetch(url); if(!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`); return readXlsxFromArrayBuffer(await res.arrayBuffer()); }

function lastNDays(data:Claim[],n:number){ const dates=Array.from(new Set(data.map(d=>d.serviceDate))).sort(); const keep=new Set(dates.slice(-n)); return data.filter(r=>keep.has(r.serviceDate)); }
function daily(data:Claim[],threshold:number){ const by=groupBy(data,r=>r.serviceDate); const dates=Array.from(by.keys()).sort(); return dates.map(date=>{ const rows=by.get(date)||[]; let allowed=0,billed=0,lpp=0,highBilled=0,denied=0,umMismatch=0,cycleSum=0,cycleN=0; for(const r of rows){ allowed+=r.allowed; billed+=r.billed; lpp+=r.lppInit; if(r.billed>=threshold) highBilled+=r.billed; if(r.denied) denied+=1; if(r.umMatch==="NO MATCH"||r.umMatch==="USERNOMATCH"||r.umMatch==="MULTI MATCH") umMismatch+=1; if(r.cycleDays!=null){cycleSum+=r.cycleDays;cycleN+=1;} } return {date,allowed,billed,lpp,highBilled,denied,umMismatch,cycleAvg:cycleN?cycleSum/cycleN:0}; }); }
function concentration(data:Claim[],byKey:"provider"|"umCase"){ const m=groupBy(data,r=>byKey==="provider"?r.provider:(r.umCase||"(blank)")); const totals=Array.from(m.values()).map(list=>list.reduce((a,r)=>a+r.allowed,0)).sort((a,b)=>b-a); const total=totals.reduce((a,v)=>a+v,0)||1; const cut=(p:number)=>totals.slice(0,Math.max(1,Math.round(totals.length*p))).reduce((a,v)=>a+v,0)/total; return {entities:totals.length,top1:cut(0.01),top5:cut(0.05),top10:cut(0.1)}; }
function topProviders(data:Claim[],k=6):TopProviderRow[]{
  const m = groupBy(data, r => r.provider);
  const rows = Array.from(m.entries()).map(([name, list]) => {
    let billed = 0, allowed = 0, denied = 0, umMismatch = 0, cycleSum = 0, cycleN = 0;
    for (const r of list) {
      billed += r.billed;
      allowed += r.allowed;
      if (r.denied) denied += 1;
      if (r.umMatch === "NO MATCH" || r.umMatch === "USERNOMATCH" || r.umMatch === "MULTI MATCH") umMismatch += 1;
      if (r.cycleDays != null) { cycleSum += r.cycleDays; cycleN += 1; }
    }
    return { name, billed, allowed, claims: list.length, denied, umMismatch, cycleAvg: cycleN ? cycleSum / cycleN : 0 };
  }).sort((a, b) => b.billed - a.billed);
  return rows.slice(0, k);
}
function reasonBreakdown(data:Claim[],k=6){ const m=groupBy(data,r=>r.reason||"(blank)"); const rows=Array.from(m.entries()).map(([reason,list])=>{ let allowed=0,denied=0,stopLoss=0; for(const r of list){ allowed+=r.allowed; if(r.denied) denied+=1; if(r.stopLoss) stopLoss+=1; } return {reason,allowed,claims:list.length,denied,stopLoss}; }).sort((a,b)=>b.allowed-a.allowed); return rows.slice(0,k); }
function parseThreshold(text:string){ const s=(text||"").toLowerCase(); const m=s.match(/[0-9]+/); const n=m?Number(m[0]):NaN; if(!Number.isFinite(n)||n<=0) return 100000; if(s.includes("k")) return n*1000; if(n>=200&&n<=999) return n*1000; return n; }
function parseIntent(q:string){ const t=(q||"").toLowerCase(); const days=t.includes("90")||t.includes("quarter")?90:t.includes("7")||t.includes("week")?7:30; const threshold=(t.includes("$")||t.includes("k")||t.includes("over")||t.includes(">="))?parseThreshold(t):100000; const wants={topProviders:t.includes("provider"),concentration:t.includes("concentration"),reasons:t.includes("reason")||t.includes("domain"),export:t.includes("export")||t.includes("csv")||t.includes("download")}; return {days,threshold,wants}; }

const ChatPanel = React.memo(({
  messages,
  send,
  downloadCSV,
  lastCsv,
  clearChat
}: {
  messages: Msg[];
  send: (text: string) => void;
  downloadCSV: (filename:string,text:string)=>void;
  lastCsv: string;
  clearChat: () => void;
}) => {
  const [query, setQuery] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setQuery(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">Agent</div>
          <div className="text-sm text-muted-foreground">Light+</div>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-2 rounded-xl border text-sm" onClick={() => setQuery("Top providers over $200k last 90 days; export csv")}> 
            <span className="inline-flex items-center gap-2"><Play className="h-4 w-4"/> Example</span>
          </button>
          <button className="px-3 py-2 rounded-xl border text-sm" onClick={clearChat}> 
            <span className="inline-flex items-center gap-2"><RefreshCcw className="h-4 w-4"/> Clear</span>
          </button>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <textarea
          ref={textareaRef}
          className="flex-1 rounded-xl border px-3 py-2 text-sm resize-none overflow-hidden"
          value={query}
          onChange={handleInputChange}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send(query))}
          placeholder="Ask a question..."
          rows={1}
          style={{ minHeight: "40px", maxHeight: "200px" }}
        />
        <button className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm self-end" onClick={() => send(query)}>Run</button>
      </div>
      <div className="mt-3 flex-1 overflow-auto rounded-xl border p-2 space-y-2">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-xl p-3 text-sm ${
              m.role === "user" ? "bg-primary text-primary-foreground ml-6" : "bg-muted mr-6"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs opacity-80">{m.role === "user" ? "You" : "Agent"}</div>
              {m.csv ? (
                <button className="px-2 py-1 rounded-lg border text-xs bg-background text-foreground" onClick={() => downloadCSV("claims_daily.csv", m.csv!)}>
                  <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5"/> CSV</span>
                </button>
              ) : null}
            </div>
            {m.node ? (
              <div className="mt-2">{m.node}</div>
            ) : (
              <div className="mt-2 whitespace-pre-wrap leading-relaxed">{m.text}</div>
            )}
            {m.followUpQuestions && m.followUpQuestions.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <div className="text-xs text-muted-foreground mb-2 font-medium">💡 {m.text === "How can I help you?" ? "Suggestions:" : "Suggested follow-ups:"}</div>
                <div className="flex flex-wrap gap-2">
                  {m.followUpQuestions.map((question, index) => (
                    <button
                      key={index}
                      className="px-3 py-1.5 rounded-lg border text-xs bg-background hover:bg-muted hover:border-primary/50 transition-all duration-200 inline-flex items-center gap-1.5 group"
                      onClick={() => send(question)}
                    >
                      <ChevronRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {lastCsv ? (
        <div className="mt-2 text-xs text-muted-foreground">
          Latest CSV ready. <button className="underline" onClick={() => downloadCSV("claims_daily.csv", lastCsv)}>Download</button>
        </div>
      ) : null}
    </div>
  );
});

function InteractiveChart({data, dataKey, title, color = "#3b82f6"}: {data: any[], dataKey: string, title: string, color?: string}) {
  const [chartType, setChartType] = useState<'line' | 'bar'>('line');

  const chartData = useMemo(() => {
    return data.map((item, index) => ({
      ...item,
      date: item.date || `Day ${index + 1}`,
      [dataKey]: Number(item[dataKey]) || 0
    }));
  }, [data, dataKey]);

  const formatValue = (value: number) => {
    if (dataKey.includes('Rate') || dataKey.includes('rate')) {
      return `${(value * 100).toFixed(1)}%`;
    }
    if (dataKey.includes('allowed') || dataKey.includes('billed') || dataKey.includes('lpp')) {
      return usd(value);
    }
    return nfmt(value);
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium">{`Date: ${label}`}</p>
          <p className="text-sm" style={{ color }}>
            {`${title}: ${formatValue(payload[0].value)}`}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        <button
          onClick={() => setChartType('line')}
          className={`px-2 py-1 text-xs rounded border ${chartType === 'line' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
        >
          Line
        </button>
        <button
          onClick={() => setChartType('bar')}
          className={`px-2 py-1 text-xs rounded border ${chartType === 'bar' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
        >
          Bar
        </button>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        {chartType === 'line' ? (
          <LineChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11 }}
              tickFormatter={(value) => {
                if (value.includes('-')) {
                  const date = new Date(value);
                  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
                return value;
              }}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickFormatter={formatValue}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              dot={{ fill: color, strokeWidth: 2, r: 4 }}
              activeDot={{ r: 6, stroke: color, strokeWidth: 2, fill: '#fff' }}
            />
          </LineChart>
        ) : (
          <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11 }}
              tickFormatter={(value) => {
                if (value.includes('-')) {
                  const date = new Date(value);
                  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
                return value;
              }}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickFormatter={formatValue}
            />
            <Tooltip content={<CustomTooltip />} />
            <Bar
              dataKey={dataKey}
              fill={color}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function InteractiveBarChart({data, dataKey, title, color = "#3b82f6"}: {data: any[], dataKey: string, title: string, color?: string}) {
  const chartData = useMemo(() => {
    return data.map((item) => ({
      ...item,
      [dataKey]: Number(item[dataKey]) || 0
    }));
  }, [data, dataKey]);

  const formatValue = (value: number) => {
    if (dataKey.includes('Rate') || dataKey.includes('rate')) {
      return `${(value * 100).toFixed(1)}%`;
    }
    if (dataKey.includes('allowed') || dataKey.includes('billed') || dataKey.includes('lpp')) {
      return usd(value);
    }
    return nfmt(value);
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium">{`${label}`}</p>
          <p className="text-sm" style={{ color }}>
            {`${title}: ${formatValue(payload[0].value)}`}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 10 }}
          angle={-45}
          textAnchor="end"
          height={70}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={formatValue}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar
          dataKey={dataKey}
          fill={color}
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

function InteractivePieChart({data, dataKey, nameKey, title, colors = ["#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"]}: {data: any[], dataKey: string, nameKey: string, title: string, colors?: string[]}) {
  const chartData = useMemo(() => {
    return data.map((item, index) => ({
      ...item,
      [dataKey]: Number(item[dataKey]) || 0,
      fill: colors[index % colors.length]
    }));
  }, [data, dataKey, colors]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-background border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium">{`${data[nameKey]}`}</p>
          <p className="text-sm" style={{ color: data.fill }}>
            {`${title}: ${usd(data[dataKey])}`}
          </p>
          <p className="text-sm text-muted-foreground">
            {`${pct(data[dataKey] / data.total)} of total`}
          </p>
        </div>
      );
    }
    return null;
  };

  const total = chartData.reduce((sum, item) => sum + item[dataKey], 0);
  const dataWithTotal = chartData.map(item => ({ ...item, total }));

  return (
    <ResponsiveContainer width="100%" height={210}>
      <PieChart>
        <Pie
          data={dataWithTotal}
          cx="50%"
          cy="50%"
          innerRadius={35}
          outerRadius={65}
          paddingAngle={2}
          dataKey={dataKey}
        >
          {dataWithTotal.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.fill} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function SankeyDiagram({data}:{data:Claim[]}) {
  // Department configurations with processing days
  const departments = [
    { name: "SIU", days: 18 },
    { name: "PSCCR", days: 9 },
    { name: "COB", days: 7 },
    { name: "CERIS", days: 7 },
    { name: "Pricing", days: 2 },
    { name: "Valenz", days: 2 }
  ];
  
  const totalDays = departments.reduce((sum, dept) => sum + dept.days, 0);

  const nodes = useMemo(() => {
    // Single source node
    const sourceNode = { name: "All Claims", id: 0 };
    
    // Department nodes include days in label for readability
    const deptNodes = departments.map((dept, i) => ({
      name: `${dept.name} (${dept.days}d)`,
      id: i + 1
    }));
    
    return [sourceNode, ...deptNodes];
  }, []);

  const links = useMemo(() => {
    const totalCount = data.length;
    
    // Distribute all claims across departments based on processing days
    return departments.map((dept, deptIndex) => {
      const daysRatio = dept.days / totalDays;
      const claimCount = Math.max(1, Math.round(totalCount * daysRatio));
      
      return {
        source: 0, // From "All Claims"
        target: deptIndex + 1, // To department
        value: claimCount
      };
    });
  }, [data]);


  // custom node element to render rectangle + label to the right
  const CustomSankeyNode = (props: any) => {
    const { x, y, width, height, payload } = props;
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} fill="#8884d8" stroke="#333" />
        <text x={x + width + 6} y={y + height / 2} fontSize={12} fill="#000" textAnchor="start" alignmentBaseline="middle">
          {payload.name}
        </text>
      </g>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={320}>
      <Sankey
          data={{ nodes, links }}
          margin={{ top: 10, right: 160, bottom: 10, left: 100 }}
          node={CustomSankeyNode}
          nodePadding={20}
          nodeWidth={80}
          link={{
            stroke: '#8884d8',
            strokeOpacity: 0.4
          }}
        >
        <Tooltip 
          contentStyle={{ 
            backgroundColor: '#fff', 
            border: '1px solid #ddd', 
            borderRadius: '4px', 
            padding: '10px' 
          }}
          formatter={(value) => {
            const numValue = Number(value);
            const percent = ((numValue / data.length) * 100).toFixed(1);
            return [`${nfmt(numValue)} claims`, `${percent}% of total`];
          }}
          labelStyle={{ color: '#000', fontSize: '12px' }}
        />
      </Sankey>
    </ResponsiveContainer>
  );
}

function AdjustmentDensity({data}:{data:Claim[]}) {
  const chartData = useMemo(() => {
    // group by provider and domain
    const map = new Map<string, { provider:string; domain:string; count:number; totalPrompt:number }>();
    
    for (const claim of data) {
      const domain = (claim.reason||"Other").toLowerCase().includes("sepsis") ? "Sepsis"
        : (claim.reason||"").toLowerCase().includes("neo") ? "Neonatal"
        : (claim.reason||"").toLowerCase().includes("onc") ? "Oncology"
        : "Other";
      const key = `${claim.provider}||${domain}`;
      const existing = map.get(key) || { provider: claim.provider, domain, count:0, totalPrompt:0 };
      existing.count += 1;
      existing.totalPrompt += claim.paidProxy; // incurred prompt pay
      map.set(key, existing);
    }
    
    // create color palette for providers
    const providers = Array.from(new Set(Array.from(map.values()).map(v=>v.provider)));
    const colors = providers.reduce((acc,p,i)=>{ acc[p]=[`#10b981`,`#f59e0b`,`#8b5cf6`,`#ef4444`,`#06b6d4`,`#a855f7`][i%6]; return acc; },{} as Record<string,string>);
    
    return Array.from(map.values()).map(v=>({
      provider:v.provider,
      domain:v.domain,
      avgPromptPay: v.count? v.totalPrompt/v.count : 0,
      color: colors[v.provider] || '#8884d8'
    }));
  }, [data]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const d = payload[0].payload;
      return (
        <div className="bg-background border rounded-lg p-3 shadow-lg text-sm">
          <p className="font-medium">{d.provider} ({d.domain})</p>
          <p className="text-xs text-muted-foreground">Avg prompt pay: {usd(d.avgPromptPay)}</p>
        </div>
      );
    }
    return null;
  };

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ScatterChart margin={{ top: 15, right: 15, bottom: 35, left: 35 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis 
          dataKey="avgPromptPay" 
          name="Avg Prompt Pay" 
          tick={{ fontSize: 10 }}
          tickFormatter={usd}
          type="number"
        />
        <YAxis 
          dataKey="domain" 
          type="category" 
          tick={{ fontSize: 10 }}
          label={{ value: 'Domain', angle: -90, position: 'insideLeft' }}
        />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<CustomTooltip />} />
        { /* render each provider group as separate scatter */ }
        {Array.from(new Set(chartData.map(d=>d.provider))).map(prov => (
          <Scatter 
            key={prov}
            name={prov}
            data={chartData.filter(d=>d.provider===prov)}
            fill={chartData.find(d=>d.provider===prov)?.color}
            fillOpacity={0.6}
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

function PromptPayDistribution({data}:{data:Claim[]}) {
  const chartData = useMemo(() => {
    const providerMap = new Map<string, {onTime: number, delayed: number, denied: number}>();
    
    for (const claim of data) {
      const existing = providerMap.get(claim.provider) || { onTime: 0, delayed: 0, denied: 0 };
      if (claim.denied) {
        existing.denied += 1;
      } else if (claim.cycleDays != null && claim.cycleDays <= 30) {
        existing.onTime += 1;
      } else {
        existing.delayed += 1;
      }
      providerMap.set(claim.provider, existing);
    }
    
    return Array.from(providerMap.entries())
      .sort((a, b) => (b[1].onTime + b[1].delayed + b[1].denied) - (a[1].onTime + a[1].delayed + a[1].denied))
      .slice(0, 6)
      .map(([provider, stats]) => ({
        provider,
        "On-Time": stats.onTime,
        "Delayed": stats.delayed,
        "Denied": stats.denied
      }));
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis 
          dataKey="provider" 
          tick={{ fontSize: 10 }}
          angle={-45}
          textAnchor="end"
          height={70}
        />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip />
        <Bar dataKey="On-Time" stackId="a" fill="#10b981" />
        <Bar dataKey="Delayed" stackId="a" fill="#f59e0b" />
        <Bar dataKey="Denied" stackId="a" fill="#ef4444" />
      </BarChart>
    </ResponsiveContainer>
  );
}
function ConcRow({c}:{c:{entities:number;top1:number;top5:number;top10:number}}){ return (<div className="mt-1 grid grid-cols-3 gap-2 text-xs"><div className="rounded-xl border p-2"><div className="text-muted-foreground">Top 1%</div><div className="mt-1 font-semibold">{pct(c.top1)}</div></div><div className="rounded-xl border p-2"><div className="text-muted-foreground">Top 5%</div><div className="mt-1 font-semibold">{pct(c.top5)}</div></div><div className="rounded-xl border p-2"><div className="text-muted-foreground">Top 10%</div><div className="mt-1 font-semibold">{pct(c.top10)}</div></div></div>); }
function Kpi({label,value,sub}:{label:string;value:string;sub:string}){ return (<div className="rounded-2xl border p-3"><div className="text-sm font-medium">{label}</div><div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div><div className="mt-1 text-xs text-muted-foreground">{sub}</div></div>); }
function MiniSelect({label,value,onChange,options}:{label:string;value:string;onChange:(v:string)=>void;options:string[]}){ return (<label className="text-xs"><span className="text-muted-foreground mr-1">{label}</span><select className="rounded-xl border px-2 py-1 text-xs bg-background" value={value} onChange={(e)=>onChange(e.target.value)}>{options.map(o=>(<option key={o} value={o}>{o}</option>))}</select></label>); }
function Card({title,subtitle,children}:{title:string;subtitle:string;children:React.ReactNode}){ return (<div className="rounded-2xl border p-3"><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground">{subtitle}</div><div className="mt-2">{children}</div></div>); }
function RowBar({name,value,max,right}:{name:string;value:number;max:number;right:string}){ const w=Math.max(2,Math.round((value/Math.max(1,max))*100)); return (<div className="rounded-xl border p-2"><div className="flex items-center justify-between gap-2"><div className="text-xs font-medium truncate" title={name}>{name}</div><div className="text-xs text-muted-foreground tabular-nums">{right}</div></div><div className="mt-2 h-2 w-full rounded-full bg-muted"><div className="h-2 rounded-full bg-foreground/40" style={{width:`${w}%`}}/></div></div>); }

// Follow-up chart components
function FirstTimeClaimsByProvider({data}:{data:Claim[]}) {
  const chartData = useMemo(() => {
    const providerCounts = new Map<string, number>();
    
    for (const claim of data.filter(c => c.seqno === 999)) {
      const count = providerCounts.get(claim.provider) || 0;
      providerCounts.set(claim.provider, count + 1);
    }
    
    return Array.from(providerCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([provider, count]) => ({
        provider,
        claims: count
      }));
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis 
          dataKey="provider" 
          tick={{ fontSize: 10 }}
          angle={-45}
          textAnchor="end"
          height={70}
        />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip />
        <Bar dataKey="claims" fill="#3b82f6" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function ServiceLinePaymentRatio({data}:{data:Claim[]}) {
  const chartData = useMemo(() => {
    const serviceMap = new Map<string, {billed: number, paid: number}>();
    
    for (const claim of data) {
      const service = claim.serviceLine || "Unknown";
      const existing = serviceMap.get(service) || { billed: 0, paid: 0 };
      existing.billed += claim.billed;
      existing.paid += claim.paidProxy;
      serviceMap.set(service, existing);
    }
    
    return Array.from(serviceMap.entries())
      .map(([service, stats]) => ({
        service,
        ratio: stats.billed > 0 ? (stats.paid / stats.billed) * 100 : 0,
        billed: stats.billed
      }))
      .sort((a, b) => b.billed - a.billed)
      .slice(0, 6);
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis 
          dataKey="service" 
          tick={{ fontSize: 10 }}
          angle={-45}
          textAnchor="end"
          height={70}
        />
        <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} />
        <Tooltip formatter={(value) => [`${value}%`, 'Payment Ratio']} />
        <Bar dataKey="ratio" fill="#10b981" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function OncologyDenialBreakdown({data}:{data:Claim[]}) {
  const chartData = useMemo(() => {
    const reasonCounts = new Map<string, number>();
    
    for (const claim of data.filter(c => c.serviceLine === "Oncology" && c.denied)) {
      const reason = claim.reason || "Unknown";
      const count = reasonCounts.get(reason) || 0;
      reasonCounts.set(reason, count + 1);
    }
    
    return Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({
        reason: reason.length > 20 ? reason.substring(0, 20) + "..." : reason,
        count
      }));
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          outerRadius={60}
          dataKey="count"
          label={({ reason, count }) => `${reason}: ${count}`}
        >
          {chartData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={["#ef4444", "#f59e0b", "#10b981", "#8b5cf6", "#06b6d4"][index % 5]} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}

function ProviderPaymentTimeChart({data}:{data:Claim[]}) {
  const chartData = useMemo(() => {
    const providerStats = new Map<string, {totalDays: number, count: number}>();
    
    for (const claim of data.filter(c => !c.denied && c.cycleDays != null)) {
      const existing = providerStats.get(claim.provider) || { totalDays: 0, count: 0 };
      existing.totalDays += claim.cycleDays!;
      existing.count += 1;
      providerStats.set(claim.provider, existing);
    }
    
    return Array.from(providerStats.entries())
      .map(([provider, stats]) => ({
        provider,
        avgDays: Math.round(stats.totalDays / stats.count)
      }))
      .sort((a, b) => a.avgDays - b.avgDays)
      .slice(0, 6);
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 40 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis 
          dataKey="provider" 
          tick={{ fontSize: 11 }}
          angle={-45}
          textAnchor="end"
          height={70}
        />
        <YAxis tick={{ fontSize: 12 }} label={{ value: 'Days', angle: -90, position: 'insideLeft' }} />
        <Tooltip formatter={(value) => [`${value} days`, 'Avg Payment Time']} />
        <Bar dataKey="avgDays" fill="#f59e0b" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function ClaimsTrendChart({data}:{data: {month: string, claims: number, denied: number}[]}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip />
        <Line type="monotone" dataKey="claims" stroke="#3b82f6" strokeWidth={2} name="Total Claims" />
        <Line type="monotone" dataKey="denied" stroke="#ef4444" strokeWidth={2} name="Denied Claims" />
      </LineChart>
    </ResponsiveContainer>
  );
}

function DelayedPaymentsChart({data}:{data:Claim[]}) {
  const chartData = useMemo(() => {
    const providerStats = new Map<string, {delayed: number, total: number}>();
    
    for (const claim of data.filter(c => !c.denied && c.cycleDays != null)) {
      const existing = providerStats.get(claim.provider) || { delayed: 0, total: 0 };
      existing.total += 1;
      if (claim.cycleDays! > 21) {
        existing.delayed += 1;
      }
      providerStats.set(claim.provider, existing);
    }
    
    return Array.from(providerStats.entries())
      .filter(([, stats]) => stats.total > 0)
      .map(([provider, stats]) => ({
        provider,
        delayRate: (stats.delayed / stats.total) * 100
      }))
      .sort((a, b) => b.delayRate - a.delayRate)
      .slice(0, 6);
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 40 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis 
          dataKey="provider" 
          tick={{ fontSize: 11 }}
          angle={-45}
          textAnchor="end"
          height={70}
        />
        <YAxis tick={{ fontSize: 12 }} label={{ value: 'Delay Rate %', angle: -90, position: 'insideLeft' }} />
        <Tooltip formatter={(value) => [`${value}%`, 'Delay Rate']} />
        <Bar dataKey="delayRate" fill="#ef4444" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function OverturnReasonsChart({data}:{data: {reason: string, count: number}[]}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          outerRadius={60}
          dataKey="count"
          label={({ reason, count }) => `${reason}: ${count}`}
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6"][index % 4]} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}

export default function App(){
  const [claims,setClaims]=useState<Claim[]>([]);
  const [dataStatus,setDataStatus]=useState("No workbook loaded (using demo rows). Put claims.xlsx in /public to auto-load.");
  const [days,setDays]=useState(30);
  const [threshold,setThreshold]=useState(100000);
  const [region,setRegion]=useState("All");
  const [trace,setTrace]=useState<TraceItem[]>([]);
  const [messages,setMessages]=useState<Msg[]>([{id:uid(),role:"assistant",text:"How can I help you?",followUpQuestions:["How many first-time claims?","Show me the total dollars billed vs. paid.","Show me the claims denial distribution by reason."]}]);

  useEffect(()=>{ (async()=>{ try{ setDataStatus("Checking /claims.xlsx …"); const c=await readXlsxFromUrl("/claims.xlsx"); if(c.length){ setClaims(c); setDataStatus(`Auto-loaded ${nfmt(c.length)} rows from /claims.xlsx.`); } else { setDataStatus("/claims.xlsx loaded but no rows mapped (using demo rows). Check column names."); } } catch { setDataStatus("No workbook loaded (using demo rows). Put claims.xlsx in /public to auto-load."); } })(); },[]);

  const demoClaims=useMemo(()=>{ const out:Claim[]=[]; const today=new Date(); for(let i=0;i<30;i++){ const d=new Date(today); d.setDate(today.getDate()-(29-i)); const ds=d.toISOString().slice(0,10); const denied=i%9===0; out.push({serviceDate:ds,svcFrom:ds,svcThru:ds,claimId:`D-${i}`,itmcd:"80",seqno:999,entryDate:ds,completedDate:ds,cycleDays:0,payAction:denied?"R1":"P0",denied,billed:120000+i*2000,allowed:60000+i*1100,paidProxy:denied?0:60000+i*1100,lppInit:100+i,umCase:i%7===0?"NO MATCH":"MATCH",umMatch:i%7===0?"NO MATCH":"MATCH",provider:`Provider ${String((i%5)+1).padStart(2,"0")}`,region:["IL","TX","NY","CA"][i%4],company:"",reason:["Oncology","Sepsis","Neonatal"][i%3],diagPrimary:"",diag:"",proc:"",discharge:"",los:6+(i%5),expLos:6,dischargeGap:i%11===0,stopLoss:(60000+i*1100)>=150000,serviceLine:["Oncology","Sepsis","NICU"][i%3]}); } return out; },[]);
  const data=claims.length?claims:demoClaims;
  const regionOptions=useMemo(()=>["All",...Array.from(new Set(data.map(c=>c.region))).sort()],[data]);
  const scoped=useMemo(()=>{ let d=lastNDays(data,days); if(region!=="All") d=d.filter(r=>r.region===region); return d; },[data,days,region]);
  const series=useMemo(()=>daily(scoped,threshold),[scoped,threshold]);
  const kpis=useMemo(()=>{ let billed=0,paid=0,allowed=0,lpp=0,denied=0,highBilled=0,umMismatch=0,cycleSum=0,cycleN=0; for(const r of scoped){ billed+=r.billed; paid+=r.paidProxy; allowed+=r.allowed; lpp+=r.lppInit; if(r.denied) denied+=1; if(r.billed>=threshold) highBilled+=r.billed; if(r.umMatch==="NO MATCH"||r.umMatch==="USERNOMATCH"||r.umMatch==="MULTI MATCH") umMismatch+=1; if(r.cycleDays!=null){cycleSum+=r.cycleDays; cycleN+=1;} } return {claims:scoped.length,billed,paid,allowed,lpp,deniedRate:scoped.length?denied/scoped.length:0,highShare:billed?highBilled/billed:0,paidToBilled:billed?paid/billed:0,allowedToBilled:billed?allowed/billed:0,umMismatchRate:scoped.length?umMismatch/scoped.length:0,cycleAvg:cycleN?cycleSum/cycleN:0}; },[scoped,threshold]);
  const topP=useMemo(()=>topProviders(scoped,6),[scoped]);
  const topR=useMemo(()=>reasonBreakdown(scoped,6),[scoped]);
  const concProv=useMemo(()=>concentration(scoped,"provider"),[scoped]);
  const concUm=useMemo(()=>concentration(scoped,"umCase"),[scoped]);
  const lastCsv=useMemo(()=> ([...messages].reverse().find(x=>x.role==="assistant"&&x.csv)?.csv) || "", [messages]);

  async function loadWorkbookFile(file:File){ setDataStatus(`Loading workbook: ${file.name}…`); try{ const c=await readXlsxFromFile(file); setClaims(c); setDataStatus(`Loaded ${nfmt(c.length)} rows from ${file.name}. Adjustments deduped by DCN (min SEQNO).`); } catch(e:any){ setDataStatus(`Failed to load workbook: ${e?.message||String(e)}`);} }
  async function loadWorkbookUrl(){ setDataStatus("Loading /claims.xlsx …"); try{ const c=await readXlsxFromUrl("/claims.xlsx"); setClaims(c); setDataStatus(`Loaded ${nfmt(c.length)} rows from /claims.xlsx.`);} catch(e:any){ setDataStatus(`Failed to load /claims.xlsx: ${e?.message||String(e)}`);} }

  // Pre-defined Q&A pairs for demo questions
  const qaPairs: { q: string; a: (data: Claim[]) => string | {text:string;node:React.ReactNode;followUpQuestions?:string[]} }[] = [
    {
      q: "How many first-time claims?",
      a: (data) => {
        const firstTime = data.filter(c => c.seqno === 999).length;
        return {
          text: `Volume Analysis: ${nfmt(firstTime)} first-time claims in the current scope.\n\nStatus Update:\n• Change detected: Claim volume up 8% (32 vs 29 last month).\n• Primary catalysts: Provider 03 onboarding (60%), new product launch (25%), direct-to-consumer campaign (15%).\n• Recommended action: Claims Ops should audit onboarding for Provider 03 and report findings by Mar 15. Would you like a reminder scheduled?`,
          followUpQuestions: [
            "Would you like to see the breakdown by provider?",
            "Should I analyze the trend over the last 6 months?",
            "Do you want to investigate the new product launch impact?"
          ]
        };
      }
    },
    {
      q: "Show me the total dollars billed vs. paid.",
      a: (data) => {
        const billed = data.reduce((sum, c) => sum + c.billed, 0);
        const paid = data.reduce((sum, c) => sum + c.paidProxy, 0);
        return {
          text: `Financial Dashboard: Billed ${usd(billed)}, Paid ${usd(paid)}, Paid-to-Billed Ratio ${pct(billed ? paid / billed : 0)}.\n\nDiagnostic Analysis:\n• Recent trend: Paid ratio decreased to 48% (previously 50% last week).\n• Root causes: Oncology denials (70%), Provider 02 disputes (20%), duplicate billing (10%).\n• Recommended action: Finance should review Oncology denials and resolve Provider 02 disputes by Mar 12. Would you like a summary emailed to the team?`,
          followUpQuestions: [
            "Would you like to see the breakdown by service line?",
            "Should I investigate the Oncology denial details?",
            "Do you want to compare this with last month's performance?"
          ]
        };
      }
    },
    {
      q: "Show me the claims denial distribution by reason.",
      a: (data) => {
        const deniedByReason = groupBy(data.filter(c => c.denied), c => c.reason || "(blank)");
        let out = "Denial Distribution by Reason:\n";
        for (const [reason, claims] of deniedByReason.entries()) {
          out += `- ${reason}: ${nfmt(claims.length)}\n`;
        }
        return {
          text: `Denial Analysis Complete.\n${out.trim()}\n\nKey Findings:\n• Oncology denials increased by 5 cases (18 vs 13 last month).\n• Primary issues: Missing clinical notes (3), incorrect codes (1), absent prior authorization (1).\n• Recommended action: Medical Review should contact Oncology providers to verify documentation by Mar 20. Would you like a briefing prepared for the next board meeting?`,
          followUpQuestions: [
            "Would you like to drill down into Oncology denial details?",
            "Should I show denials by provider instead?",
            "Do you want to see the trend over time for specific denial reasons?"
          ]
        };
      }
    },
    {
      q: "How many disputes and inquiries have we received?",
      a: () => {
        return {
          text: `Correspondence Analysis: 42 total disputes and inquiries received, exceeding the expected threshold.\n\nSituation Report:\n• Change detected: Disputes up 10% (42 vs 38 target).\n• Primary drivers: Provider 01 (50%), delayed payments (30%), portal errors (20%).\n• Recommended action: Provider Relations should meet with Provider 01 and resolve payment issues by Mar 18. IT should investigate portal reliability. Would you like an action plan drafted?`,
          followUpQuestions: [
            "Would you like to see the breakdown by dispute type?",
            "Should I investigate Provider 01's specific issues?",
            "Do you want to track the resolution timeline for these disputes?"
          ]
        };
      }
    },
    {
      q: "How many disputes were overturned versus upheld?",
      a: () => {
        return {
          text: `Appeals Summary: 18 disputes overturned, 24 disputes upheld.\n\nPerformance Update:\n• Improvement: Overturned rate increased 15% (18/42 vs 15/40 last week).\n• Success factors: Appeals checklist (2 cases), expedited review (1), improved documentation (remainder).\n• Recommended action: Appeals Team should track checklist compliance and submit process improvement report by Mar 22. Would you like a follow-up scheduled?`,
          followUpQuestions: [
            "Would you like to see the reasons for overturned disputes?",
            "Should I analyze the appeals process efficiency?",
            "Do you want to compare success rates by dispute category?"
          ]
        };
      }
    },
    {
      q: "What types of recovery operations were performed?",
      a: () => {
        return {
          text: `Recovery Operations Summary: Overpayment recoupment, Coordination of Benefits, and Subrogation.\n\nHighlights:\n• Achievement: Subrogation recoveries doubled ($40K vs $20K last month).\n• Contributing factors: New audit tool ($15K), staff training ($3K), external vendor ($2K).\n• Recommended next steps: Recovery Team should expand audit scope and set vendor targets by Mar 25. Would you like the team notified?`,
          followUpQuestions: [
            "Would you like to see the dollar amounts recovered by type?",
            "Should I analyze the ROI of the new audit tool?",
            "Do you want to identify additional recovery opportunities?"
          ]
        };
      }
    },
    {
      q: "Show me the prompt pay distribution by provider",
      a: (data) => {
        const byProvider = groupBy(data.filter(c => !c.denied), c => c.provider);
        let out = "Prompt Pay Distribution by Provider:\n";
        for (const [provider, claims] of byProvider.entries()) {
          out += `- ${provider}: ${nfmt(claims.length)} paid\n`;
        }
        return {
          text: `Prompt Pay Summary:\n${out.trim()}\n\nSee the chart below for detailed breakdown of the top 6 providers.`,
          node: <PromptPayDistribution data={data} />,
          followUpQuestions: [
            "Would you like to see the average payment time by provider?",
            "Should I identify providers with delayed payments?",
            "Do you want to analyze prompt pay trends over time?"
          ]
        };
      }
    }
  ];

  // Follow-up Q&A pairs for deeper investigation
  const followupPairs: { q: string; a: (data: Claim[]) => string | {text:string;node:React.ReactNode} }[] = [
    {
      q: "Would you like to see the breakdown by provider?",
      a: (data) => {
        const firstTimeByProvider = groupBy(data.filter(c => c.seqno === 999), c => c.provider);
        let out = "First-Time Claims by Provider:\n";
        for (const [provider, claims] of firstTimeByProvider.entries()) {
          out += `- ${provider}: ${nfmt(claims.length)} claims\n`;
        }
        return {
          text: `Provider Breakdown Analysis:\n${out.trim()}\n\nKey Insights:\n• Provider 03: 12 first-time claims (37.5% of total) - highest volume\n• Provider 01: 8 first-time claims (25% of total)\n• Provider 02: 6 first-time claims (18.8% of total)\n\nSee the chart below for visual breakdown.`,
          node: <FirstTimeClaimsByProvider data={data} />
        };
      }
    },
    {
      q: "Would you like to see the breakdown by service line?",
      a: (data) => {
        const billedByService = groupBy(data, c => c.serviceLine || "Unknown");
        let out = "Financial Breakdown by Service Line:\n";
        for (const [service, claims] of billedByService.entries()) {
          const billed = claims.reduce((sum, c) => sum + c.billed, 0);
          const paid = claims.reduce((sum, c) => sum + c.paidProxy, 0);
          out += `- ${service}: Billed ${usd(billed)}, Paid ${usd(paid)} (${pct(billed ? paid/billed : 0)})\n`;
        }
        return {
          text: `Service Line Financial Analysis:\n${out.trim()}\n\nCritical Findings:\n• Oncology: $2.1M billed, $1.8M paid (85.7% ratio) - below target\n• Cardiology: $1.9M billed, $1.7M paid (89.5% ratio)\n• Emergency: $1.4M billed, $1.3M paid (92.9% ratio) - highest ratio\n\nSee the chart below for payment ratios by service line.`,
          node: <ServiceLinePaymentRatio data={data} />
        };
      }
    },
    {
      q: "Would you like to drill down into Oncology denial details?",
      a: (data) => {
        const oncologyClaims = data.filter(c => c.serviceLine === "Oncology" && c.denied);
        const denialReasons = groupBy(oncologyClaims, c => c.reason || "Unknown");
        let out = "Oncology Denial Details:\n";
        for (const [reason, claims] of denialReasons.entries()) {
          const totalBilled = claims.reduce((sum, c) => sum + c.billed, 0);
          out += `- ${reason}: ${nfmt(claims.length)} claims, ${usd(totalBilled)} billed\n`;
        }
        return {
          text: `Oncology Denial Deep Dive:\n${out.trim()}\n\nRoot Cause Analysis:\n• Missing clinical notes: 8 cases ($180K impact) - documentation gaps\n• Incorrect coding: 5 cases ($95K impact) - training opportunity\n• Prior authorization issues: 3 cases ($75K impact) - process bottleneck\n\nRecommended Actions:\n• Schedule oncology provider documentation training by Mar 15\n• Review prior authorization workflow for efficiency gains\n• Implement automated coding validation checks`,
          node: <OncologyDenialBreakdown data={data} />
        };
      }
    },
    {
      q: "Would you like to see the average payment time by provider?",
      a: (data) => {
        const providerPaymentTimes = new Map<string, {totalDays: number, count: number}>();
        
        for (const claim of data.filter(c => !c.denied && c.cycleDays != null)) {
          const existing = providerPaymentTimes.get(claim.provider) || { totalDays: 0, count: 0 };
          existing.totalDays += claim.cycleDays!;
          existing.count += 1;
          providerPaymentTimes.set(claim.provider, existing);
        }
        
        let out = "Average Payment Time by Provider:\n";
        for (const [provider, stats] of providerPaymentTimes.entries()) {
          const avgDays = Math.round(stats.totalDays / stats.count);
          out += `- ${provider}: ${avgDays} days average\n`;
        }
        
        return {
          text: `Payment Cycle Analysis:\n${out.trim()}\n\nPerformance Summary:\n• Provider 01: 18 days (within target of 21 days)\n• Provider 02: 25 days (exceeds target by 4 days)\n• Provider 03: 22 days (slightly over target)\n\nKey Issues:\n• Provider 02 showing consistent delays - investigate processing bottlenecks\n• Overall average: 21.5 days vs target of 21 days\n\nSee the chart below for detailed payment time distribution.`,
          node: <ProviderPaymentTimeChart data={data} />
        };
      }
    },
    {
      q: "Should I analyze the trend over the last 6 months?",
      a: (data) => {
        // Mock 6-month trend data
        const trendData = [
          { month: "Sep 2025", claims: 28, denied: 12 },
          { month: "Oct 2025", claims: 31, denied: 14 },
          { month: "Nov 2025", claims: 29, denied: 11 },
          { month: "Dec 2025", claims: 35, denied: 16 },
          { month: "Jan 2026", claims: 33, denied: 15 },
          { month: "Feb 2026", claims: 32, denied: 13 }
        ];
        
        return {
          text: `6-Month Trend Analysis:\n\nMonthly Volume & Denial Rates:\n• September: 28 claims, 43% denial rate\n• October: 31 claims, 45% denial rate\n• November: 29 claims, 38% denial rate\n• December: 35 claims, 46% denial rate\n• January: 33 claims, 45% denial rate\n• February: 32 claims, 41% denial rate\n\nTrend Insights:\n• Volume increased 14% from Sep to Feb (28 → 32 claims)\n• Denial rate fluctuated between 38-46%, currently at 41%\n• Peak volume in December (35 claims) - holiday season impact\n• Lowest denial rate in November (38%) - process improvement effect\n\nSee the trend chart below for visual analysis.`,
          node: <ClaimsTrendChart data={trendData} />
        };
      }
    },
    {
      q: "Should I identify providers with delayed payments?",
      a: (data) => {
        const delayedProviders = new Map<string, {delayed: number, total: number, avgDelay: number}>();
        
        for (const claim of data.filter(c => !c.denied && c.cycleDays != null)) {
          const existing = delayedProviders.get(claim.provider) || { delayed: 0, total: 0, avgDelay: 0 };
          existing.total += 1;
          if (claim.cycleDays! > 21) { // Assuming 21 days is the target
            existing.delayed += 1;
            existing.avgDelay += claim.cycleDays!;
          }
          delayedProviders.set(claim.provider, existing);
        }
        
        let out = "Providers with Delayed Payments (>21 days):\n";
        const delayedList = Array.from(delayedProviders.entries())
          .filter(([, stats]) => stats.delayed > 0)
          .sort((a, b) => b[1].delayed - a[1].delayed);
          
        for (const [provider, stats] of delayedList) {
          const avgDelay = stats.avgDelay > 0 ? Math.round(stats.avgDelay / stats.delayed) : 0;
          out += `- ${provider}: ${stats.delayed}/${stats.total} delayed (${pct(stats.delayed/stats.total)}), avg ${avgDelay} days\n`;
        }
        
        return {
          text: `Delayed Payment Analysis:\n${out.trim()}\n\nCritical Issues Identified:\n• Provider 02: 8/12 claims delayed (67%) - highest delay rate\n• Provider 03: 5/15 claims delayed (33%)\n• Provider 01: 2/18 claims delayed (11%) - best performance\n\nRecommended Actions:\n• Contact Provider 02 immediately to resolve processing issues\n• Review Provider 03's submission quality\n• Share Provider 01's best practices with other providers\n\nSee the chart below for delay rates by provider.`,
          node: <DelayedPaymentsChart data={data} />
        };
      }
    },
    {
      q: "Would you like to see the reasons for overturned disputes?",
      a: () => {
        const overturnReasons = [
          { reason: "Documentation provided", count: 8 },
          { reason: "Medical necessity clarified", count: 5 },
          { reason: "Coding error corrected", count: 3 },
          { reason: "Timely filing confirmed", count: 2 }
        ];
        
        let out = "Reasons for Overturned Disputes:\n";
        for (const item of overturnReasons) {
          out += `- ${item.reason}: ${item.count} cases\n`;
        }
        
        return {
          text: `Dispute Overturn Analysis:\n${out.trim()}\n\nSuccess Patterns:\n• Documentation issues resolved 44% of overturns (8/18)\n• Medical necessity clarifications: 28% (5/18)\n• Coding corrections: 17% (3/18)\n• Timely filing confirmations: 11% (2/18)\n\nKey Insights:\n• Most overturns involve additional documentation submission\n• Medical necessity appeals have high success rate\n• Coding errors are correctable with proper review\n\nRecommended Actions:\n• Enhance provider communication for documentation requirements\n• Train appeals team on medical necessity criteria\n• Implement automated coding validation before submission`,
          node: <OverturnReasonsChart data={overturnReasons} />
        };
      }
    }
  ];

  function findAnswer(q: string, data: Claim[]): string | {text:string;node:React.ReactNode;followUpQuestions?:string[]} | null {
    const norm = q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    
    // Check main qaPairs first
    for (const { q: question, a } of qaPairs) {
      const qnorm = (question || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!qnorm) continue;
      if (norm.includes(qnorm)) {
        return a(data);
      }
    }
    
    // Check follow-up pairs
    for (const { q: question, a } of followupPairs) {
      const qnorm = (question || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!qnorm) continue;
      if (norm.includes(qnorm)) {
        return a(data);
      }
    }
    
    return null;
  }

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages(m => [...m, { id: uid(), role: "user", text: trimmed }]);
    // Check for pre-defined Q&A
    const answer = findAnswer(trimmed, scoped);
    if (answer) {
      if (typeof answer === "string") {
        setMessages(m => [...m, { id: uid(), role: "assistant", text: answer }]);
      } else {
        setMessages(m => [...m, { id: uid(), role: "assistant", text: answer.text, node: answer.node, followUpQuestions: answer.followUpQuestions }]);
      }
    } else {
      setMessages(m => [...m, { id: uid(), role: "assistant", text: "Agent runner is enabled in the full version. This fallback build focuses on the dashboard + CSV download from UI buttons." }]);
    }
  }, [scoped]);

  const clearChat = useCallback(() => {
    setMessages([{id:uid(),role:"assistant",text:"How can I help you?",followUpQuestions:["How many first-time claims?","Show me the total dollars billed vs. paid.","Show me the claims denial distribution by reason."]}]);
  }, []);

  return (
    <div className="bg-background text-foreground w-full overflow-x-hidden">
      <div className="w-full px-2 sm:px-4 lg:px-6 py-2 sm:py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-2xl border flex items-center justify-center"><ShieldAlert className="h-5 w-5"/></div>
            <div>
              <div className="text-2xl font-semibold tracking-tight">Agentic Claims Analytics</div>
              <div className="text-sm text-muted-foreground">prototype</div>
            </div>
          </div>
          <button className="px-3 py-2 rounded-xl border text-sm" onClick={()=>{ setDays(30); setThreshold(100000); setRegion("All"); setTrace([]); setMessages(m=>[m[0]]); }}>
            <span className="inline-flex items-center gap-2"><RefreshCcw className="h-4 w-4"/> Reset</span>
          </button>
        </div>

        <div className="mt-4 rounded-2xl border p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium">Data source</div>
              <div className="text-xs text-muted-foreground">{dataStatus}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="px-3 py-2 rounded-xl border text-sm cursor-pointer inline-flex items-center gap-2">
                <UploadCloud className="h-4 w-4"/> Upload .xlsx
                <input type="file" accept=".xlsx" className="hidden" onChange={(e)=>e.target.files?.[0] && loadWorkbookFile(e.target.files[0])}/>
              </label>
              <button className="px-3 py-2 rounded-xl border text-sm" onClick={loadWorkbookUrl}>Load /claims.xlsx</button>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-col lg:flex-row gap-2 sm:gap-3 min-h-[50vh] sm:min-h-[55vh] max-h-[75vh]">
          <div className="flex-1 flex flex-col rounded-2xl border p-4 min-h-0">
            <ChatPanel
              messages={messages}
              send={send}
              downloadCSV={downloadCSV}
              lastCsv={lastCsv}
              clearChat={clearChat}
            />
          </div>

          <div className="flex-1 rounded-2xl border p-4 overflow-auto min-h-0">
            <div className="flex flex-wrap gap-2">
              <MiniSelect label="Days" value={String(days)} onChange={(v)=>setDays(Number(v))} options={["7","30","60","90"]}/>
              <MiniSelect label="Region" value={region} onChange={setRegion} options={regionOptions}/>
              <MiniSelect label="Threshold" value={String(threshold)} onChange={(v)=>setThreshold(Number(v))} options={["75000","100000","150000","200000","300000"]}/>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Kpi label={`Billed ≥ ${usd(threshold)}`} value={pct(kpis.highShare)} sub="Share of billed" />
              <Kpi label="Paid / Billed" value={pct(kpis.paidToBilled)} sub={`Billed ${usd(kpis.billed)}`} />
              <Kpi label="Billed" value={usd(kpis.billed)} sub={`Claims in scope • ${nfmt(kpis.claims)}`} />
              <Kpi label="Denial rate" value={pct(kpis.deniedRate)} sub="PAY_ACT_CD starts with R" />
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Card title="Daily allowed" subtitle="sum of allowed"><InteractiveChart data={series} dataKey="allowed" title="Allowed Amount" color="#10b981"/></Card>
              <Card title="Daily UM mismatches" subtitle="NO/MULTI/USERNOMATCH cases"><InteractiveChart data={series} dataKey="umMismatch" title="UM Mismatches" color="#f59e0b"/></Card>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Card title="Provider Concentration" subtitle="Prompt pay distribution"><PromptPayDistribution data={scoped}/></Card>
              <Card title="UM case concentration" subtitle="share of allowed"><ConcRow c={concUm}/></Card>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Card title="Cycle time trends" subtitle="average days to process">
                <InteractiveChart data={series} dataKey="cycleAvg" title="Cycle Time (days)" color="#ef4444"/>
              </Card>
              <Card title="Daily billed vs allowed" subtitle="comparison over time">
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={series.map(item => ({ ...item, date: item.date || `Day ${series.indexOf(item) + 1}` }))} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={usd} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div className="bg-background border rounded-lg p-3 shadow-lg">
                              <p className="text-sm font-medium">{`Date: ${label}`}</p>
                              <p className="text-sm text-green-600">{`Allowed: ${usd(payload[0]?.value || 0)}`}</p>
                              <p className="text-sm text-blue-600">{`Billed: ${usd(payload[1]?.value || 0)}`}</p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Line type="monotone" dataKey="allowed" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="billed" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </Card>
            </div>

            <div className="mt-3">
              <Card title="Claim Processing Density by Department" subtitle="Shows claim flow through departments with processing days">
                <SankeyDiagram data={scoped} />
              </Card>
            </div>

            <div className="mt-3">
              <Card title="Claim Adjustment Density" subtitle="Provider intensity and density of adjustments (X: Avg Prompt Pay, Y: Domain)">
                <AdjustmentDensity data={scoped} />
              </Card>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Card title="Prompt Pay Status" subtitle="breakdown by payment status">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={[
                    { name: "Paid On-Time", value: scoped.filter(c => !c.denied && c.cycleDays! <= 30).length },
                    { name: "Delayed", value: scoped.filter(c => !c.denied && c.cycleDays! > 30).length },
                    { name: "Denied", value: scoped.filter(c => c.denied).length }
                  ]} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(value) => nfmt(value as number)} />
                    <Bar dataKey="value" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
              <Card title="Denial Rate by Provider" subtitle="Provider-specific denial patterns">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart 
                    data={topP.map(p => ({ name: p.name, denialRate: p.denied / p.claims }))}
                    margin={{ top: 5, right: 5, left: 5, bottom: 25 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis 
                      dataKey="name" 
                      tick={{ fontSize: 11 }}
                      angle={-45}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis tick={{ fontSize: 12 }} label={{ value: 'Denial %', angle: -90, position: 'insideLeft' }} />
                    <Tooltip 
                      formatter={(value) => `${(Number(value) * 100).toFixed(1)}%`}
                      labelFormatter={(label) => `Provider: ${label}`}
                    />
                    <Bar dataKey="denialRate" fill="#ef4444" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
