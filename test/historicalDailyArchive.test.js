import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withHistoricalDailyArchive } from '../utils/historicalDailyArchive.js';
import { ArchiveError } from '../utils/private-archive-reader/reader.mjs';

const missing = () => new ArchiveError('ARCHIVE_NOT_FOUND', 404);
const rows = {'12':{matchId:9,tp:12,day:'2026-11-23'},'11':{matchId:8,tp:11,day:'1990-01-01'}};
function reader(dates, matches, name) {
    const readPath = (path) => {
        if (path.startsWith('matches/') && !matches[path.slice(8,-3)]) throw missing();
        return name+':'+path;
    };
    return {releaseId:name,through:dates.at(-1),availableDates:async()=>dates,
        locateMatchByTp:async id=>matches[id]??null,
        locateMatchById:async id=>Object.values(matches).find(r=>r.matchId===Number(id))??null,
        readJson:readPath,readRelative:readPath,readVerified:readPath,index:()=>name,
        read:(kind,id)=>readPath(`${kind}/${id}.br`)};
}
test('joins dates without shadowing any current day, match, index or report', async () => {
    const recent=reader(['2026-11-01','2026-11-23'], {12:rows[12]}, 'live');
    const old=reader(['1990-01-01','2026-11-01','2026-11-16'],
        {11:rows[11],12:{...rows[12],day:'2026-10-31'},13:{matchId:7,tp:13,day:'2026-11-16'}}, 'history');
    const view=withHistoricalDailyArchive(recent,async()=>old);
    assert.equal(view.releaseId,'live');
    assert.equal(view.through,'2026-11-23');
    assert.deepEqual(await view.availableDates(),['1990-01-01','2026-11-01','2026-11-23']);
    assert.equal(await view.readJson('daily/19900101.br'),'history:daily/19900101.br');
    assert.equal(await view.read('daily','20261101'),'live:daily/20261101.br');
    assert.equal(await view.readVerified('matches/11.br'),'history:matches/11.br');
    assert.equal(await view.read('matches','12'),'live:matches/12.br');
    assert.equal(await view.locateDate(11),'1990-01-01');
    assert.equal(await view.locateDate(13),null);
    assert.equal(await view.locateDate(12),'2026-11-23');
    assert.deepEqual(await view.locateMatchById(8),rows[11]);
    assert.equal(await view.readJson('analytics/snapshot.json'),'live:analytics/snapshot.json');
    assert.equal(await view.readRelative('research/simulation-min10-study.json'),'live:research/simulation-min10-study.json');
    assert.equal(await view.index('players'),'live');
    await assert.rejects(view.read('matches','13'),{status:404});
});

test('a history failure does not break recent dates or mask a recent integrity error', async () => {
    const recent=reader(['2026-11-23'],{},'live');
    recent.readVerified=()=>{throw new ArchiveError('ARCHIVE_INTEGRITY');};
    let attempts=0, notices=0;
    const view=withHistoricalDailyArchive(recent,async()=>{
        attempts++;
        throw new ArchiveError('ARCHIVE_STORAGE_UNAVAILABLE');
    },()=>notices++);
    assert.equal(await view.readJson('daily/20261123.br'),'live:daily/20261123.br');
    await assert.rejects(view.readVerified('matches/12.br'),{code:'ARCHIVE_INTEGRITY'});
    assert.equal(attempts,0);
    assert.deepEqual(await view.availableDates(),['2026-11-23']);
    assert.equal(notices,1);
    await assert.rejects(view.readJson('daily/19900101.br'),{code:'ARCHIVE_STORAGE_UNAVAILABLE'});
});
