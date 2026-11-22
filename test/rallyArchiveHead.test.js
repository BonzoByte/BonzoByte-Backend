import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateArchiveRuntime,PRIVATE_ARCHIVE_ENDPOINT} from '../utils/privateArchiveRuntime.js';
import {checkedRallyArchiveHead,readRallyArchiveHead,RALLY_ARCHIVE_HEAD_KEY} from '../utils/rallyArchiveHead.js';

const key=sha=>`publisher-staging-v1/objects/${sha.slice(0,2)}/${sha}.json`;
const anchor='a'.repeat(64), next='b'.repeat(64), release='d'.repeat(64);
const config={ARCHIVES_SOURCE:'publisher',APP_STAGE:'beta',BONZOBYTE_ARCHIVE_CANDIDATE_KEY:key(anchor),
    BONZOBYTE_ARCHIVE_CANDIDATE_SHA256:anchor,BONZOBYTE_ARCHIVE_CANDIDATE_BYTES:'10',
    BONZOBYTE_ARCHIVE_READ_ENDPOINT:PRIVATE_ARCHIVE_ENDPOINT};
const good={schema:'bonzobyte.rally-recent-head.v1',anchor,candidate:{key:key(next),sha256:next,bytes:20},release,through:'2026-11-22'};
test('switches only to an intact release and retains it if the head is unavailable',async()=>{
    let head=null,clock=0,reads=0;
    const runtime=createPrivateArchiveRuntime({settings:config,getObject:()=>{},now:()=>clock,getHead:async()=>{reads++;return head;},
        openReader:async({candidate})=>candidate.sha256===anchor
            ?{releaseId:anchor,through:'2026-11-21',availableDates:async()=>['2026-11-21']}
            :{releaseId:release,through:'2026-11-22',availableDates:async()=>['2026-11-21','2026-11-22']}});
    assert.equal((await runtime.getReader()).releaseId,anchor);
    head=good; clock=30_001;
    assert.deepEqual((await Promise.all([runtime.getReader(),runtime.getReader()])).map(x=>x.releaseId),[release,release]);
    assert.equal(reads,2);
    clock+=30_001;head={...good,anchor:'f'.repeat(64)};
    assert.equal((await runtime.getReader()).releaseId,release);
    clock+=30_001;head={...good,candidate:{key:key(anchor),sha256:anchor,bytes:10},release:anchor,through:'2026-11-21'};
    assert.equal((await runtime.getReader()).releaseId,anchor);
});

test('rejects a candidate when its date list is incomplete',async()=>{
    const r=createPrivateArchiveRuntime({settings:config,getObject:()=>{},getHead:async()=>good,
        openReader:async({candidate})=>candidate.sha256===anchor?{releaseId:anchor,through:'2026-11-21'}:
            {releaseId:release,through:'2026-11-22',availableDates:async()=>['2026-11-21']}});
    assert.equal((await r.getReader()).releaseId,anchor);
});

test('fixed safe object and bounded head body',async()=>{
    const raw=Buffer.from(JSON.stringify(good));
    class Command {constructor(input){this.input=input;}}
    const client={send:async cmd=>{assert.deepEqual(cmd.input,{Bucket:'fixture',Key:RALLY_ARCHIVE_HEAD_KEY});
        return {ContentLength:raw.length,Body:[raw]};}};
    assert.deepEqual(checkedRallyArchiveHead(await readRallyArchiveHead(client,Command,'fixture'),anchor),good);
    assert.throws(()=>checkedRallyArchiveHead({...good,candidate:{...good.candidate,key:'wrong'}},anchor));
    await assert.rejects(readRallyArchiveHead({send:async()=>({ContentLength:9000,Body:[raw]})},Command,'fixture'),/RALLY_HEAD_SIZE/);
});
