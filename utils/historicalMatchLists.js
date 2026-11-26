import {brotliCompress, constants} from 'node:zlib';
import {promisify} from 'node:util';
import {ArchiveError} from './private-archive-reader/reader.mjs';

const compress=promisify(brotliCompress);
const validId=n=>Number.isSafeInteger(n)&&n>0;
const absent=e=>e instanceof ArchiveError&&e.code==='ARCHIVE_NOT_FOUND'&&e.status===404;
const missing=()=>new ArchiveError('ARCHIVE_NOT_FOUND',404);

async function optionalList(reader,path,options,member){
    let file;
    try{file=await reader.readVerified(path,options);}
    catch(e){if(absent(e))return null;throw e;}
    const rows=JSON.parse(file.decoded.toString('utf8'));
    const tps=new Set(),ids=new Set();
    if(!Array.isArray(rows)||rows.some(r=>{
        if(!r||!validId(r.l01)||!validId(r.l44)||!member(r)||!/^\d{4}-\d{2}-\d{2}(?:T| |$)/.test(r.l02)||
            tps.has(r.l01)||ids.has(r.l44))return true;
        tps.add(r.l01);ids.add(r.l44);return false;
    }))throw new ArchiveError('ARCHIVE_LIST_INTEGRITY');
    return {rows,raw:file.raw,tps,ids};
}

/** Only the two existing list endpoints opt in. No archive writes or general path fallback. */
export async function readHistoricalMatchList(recent,getHistory,firstRecentDay,kind,name,options){
    const id=Number(name);
    if(!['players/matches','tournaments/matches'].includes(kind)||!validId(id)||String(id)!==String(name))
        throw new ArchiveError('INVALID_ARCHIVE_REQUEST',400);
    const path=`${kind}/${id}.br`;
    const member=kind==='players/matches'?r=>r.l13===id||r.l20===id:r=>r.l32===id;
    const [live,past]=await Promise.all([optionalList(recent,path,options,member),
        getHistory().then(h=>optionalList(h,path,options,member))]);
    if(!live&&!past)throw missing();
    if(!past)return live.raw;
    // The live head owns outcomes and schedules from the boundary onward,
    // even when an old release also had a row for that date.
    const older=past.rows.filter(r=>r.l02.slice(0,10)<firstRecentDay&&!live?.tps.has(r.l01)&&!live?.ids.has(r.l44));
    if(!older.length&&live)return live.raw;
    if(!live&&older.length===past.rows.length)return past.raw;
    const rows=[...(live?.rows??[]),...older].sort((a,b)=>
        a.l02<b.l02?1:a.l02>b.l02?-1:b.l01-a.l01);
    options?.signal?.throwIfAborted();
    // Only the HTTP response needs encoding when the two verified lists overlap.
    return compress(Buffer.from(JSON.stringify(rows)),{params:{[constants.BROTLI_PARAM_QUALITY]:3}});
}
