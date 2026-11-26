import {test} from 'node:test';
import assert from 'node:assert/strict';
import {brotliCompressSync,brotliDecompressSync} from 'node:zlib';
import {ArchiveError} from '../utils/private-archive-reader/reader.mjs';
import {withHistoricalDailyArchive} from '../utils/historicalDailyArchive.js';

const game=(tp,day,extra={})=>({l01:tp,l44:tp+100,l02:day+'T18:30:00',l13:9,l20:10,l32:4,...extra});
const err=()=>new ArchiveError('ARCHIVE_NOT_FOUND',404);
function file(rows){
    const decoded=Buffer.from(JSON.stringify(rows));
    return {raw:brotliCompressSync(decoded),decoded};
}
const reader=(contents,expected)=>({async readVerified(p){
    assert.equal(p,expected);
    if(!contents)throw err();if(contents instanceof Error)throw contents;return contents;
}});
for(const [kind,id] of [['players/matches',9],['tournaments/matches',4]]){
    const path=kind+'/'+id+'.br', view=(live,old)=>withHistoricalDailyArchive(reader(live,path),async()=>reader(old,path));
    test(kind+': returns exact existing bytes when only one edition is needed',async()=>{
        const past=file([game(1,'1990-01-01')]),now=file([game(4,'2026-11-26')]);
        assert.equal(await view(null,past).read(kind,String(id)),past.raw);
        assert.equal(await view(now,null).read(kind,String(id)),now.raw);
        await assert.rejects(view(null,null).read(kind,id),{code:'ARCHIVE_NOT_FOUND'});
        // An old copy of an entry on a recent date is not an authoritative result.
        assert.deepEqual(JSON.parse(brotliDecompressSync(await view(null,now).read(kind,id))),[]);
    });
    test(kind+': preserves active results; handles postponed and remapped matches; sorts across the cutoff',async()=>{
        const old=file([game(3,'2026-11-01'),game(4,'2026-10-31'),game(8,'2026-10-30',{l44:105}),
            game(1,'1990-01-01'),game(2,'2001-01-01')]);
        const live=file([game(5,'2026-11-25'),game(4,'2026-11-26',{l27:'21'})]);
        const rows=JSON.parse(brotliDecompressSync(await view(live,old).read(kind,id)));
        assert.deepEqual(rows.map(r=>r.l01),[4,5,2,1]);assert.equal(rows[0].l27,'21');
    });
    test(kind+': wrong membership, corrupt or unavailable archives are not silently treated as empty',async()=>{
        const badMember=game(1,'1990-01-01',{l13:1,l20:2,l32:11}),badStore=new ArchiveError('ARCHIVE_INTEGRITY');
        await assert.rejects(view(null,file([badMember])).read(kind,id),{code:'ARCHIVE_LIST_INTEGRITY'});
        await assert.rejects(view(badStore,null).read(kind,id),{code:'ARCHIVE_INTEGRITY'});
        await assert.rejects(view(file([]),badStore).read(kind,id),{code:'ARCHIVE_INTEGRITY'});
    });
}
