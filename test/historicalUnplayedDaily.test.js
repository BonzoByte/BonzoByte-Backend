import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoricalUnplayedDaily, loadHistoricalUnplayedDaily } from '../utils/historicalUnplayedDaily.js';

const d = '20210513';
const ghost = {l44:1443674,l01:824427297,l32:176068,l13:528457,l20:524062,l02:'2021-05-13T00:00:00',
    l12:'round of 16',l03:false,l27:null,l28:null,l31:null,l40:false,l41:false};
const played = {...ghost,l44:1443676,l01:824424695,l13:559338,l20:528457,l03:true,l27:'21',l28:'2:1 6:0 3:6 6:4',
    l38:'Validated',l40:true,l41:true,l31:26.05};
const untouched = {...ghost,l44:100,l01:456};
const manifest = {schema:'bonzobyte.unplayed-historical-daily.v1',rows:[
    [d,ghost.l44,ghost.l01,ghost.l32,ghost.l13,ghost.l20,ghost.l12,played.l44,played.l01,played.l13,played.l20,played.l27,played.l28],
]};

test('production pack removes only Baindl–Babos while retaining the proved alternative and unrelated blanks', () => {
    const all=[ghost,played,untouched];
    const shown=loadHistoricalUnplayedDaily()(d,all);
    assert.deepEqual(shown,[played,untouched]);
    assert.equal(shown[0],played);
    assert.equal(shown[1],untouched);
    assert.equal(all.length,3);
});

test('fails open if an original or alternative row changes, an identity is ambiguous, or date is recent', () => {
    const filter=createHistoricalUnplayedDaily(manifest);
    for (const patch of [{l03:true},{l32:999},{l13:999},{l20:999},{l27:'20'},
        {l31:50},{l40:true},{l41:true},{l12:'quarter finals'},{l02:'2021-05-14'}]) {
        const records=[{...ghost,...patch},played];
        assert.deepEqual(filter(d,records),records);
    }
    for (const patch of [{l13:42},{l03:false},{l28:'2:0 6:1 6:2'},{l40:false},{l38:'NotAssessed'}]) {
        const records=[ghost,{...played,...patch}];
        assert.deepEqual(filter(d,records),records);
    }
    for (const records of [[ghost],[ghost,ghost,played]]) assert.deepEqual(filter(d,records),records);
    const live=[ghost,played];
    assert.equal(filter('20261123',live),live);
});

test('does not load a broad or duplicate suppression rule', () => {
    const entry=manifest.rows[0];
    assert.throws(() => createHistoricalUnplayedDaily({...manifest,rows:[entry,entry]}));
    assert.throws(() => createHistoricalUnplayedDaily({...manifest,rows:[['20261123',...entry.slice(1)]]}));
    assert.throws(() => createHistoricalUnplayedDaily({...manifest,rows:[entry.slice(0,10)]}));
});
