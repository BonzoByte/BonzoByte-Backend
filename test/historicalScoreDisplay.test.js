import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { createHistoricalScoreDisplay, loadHistoricalScoreDisplay } from '../utils/historicalScoreDisplay.js';
import { projectPublicDailyMatch } from '../utils/publicDailyMatch.js';

const expected = ['21','2:1 6:1 6:2 6:4'];
const after = ['30','3:0 6:1 6:2 6:4'];
const compactDay = '20000121';
const sample = {l01:821388268,l32:13655,l13:431401,l20:431497,l44:63329,l02:'2000-01-21T14:20:00',
    l27:expected[0],l28:expected[1],l03:true,l31:null,l38:'NotAssessed',l40:false,l41:false,l29:4.25};
const detail = {m001:sample.l01,m002:sample.l32,m003:sample.l02,m004:sample.l13,m005:sample.l20,m010:expected[0],
    m011:expected[1],m655:null,m656:true,q:{MatchId:sample.l44,CalculationEligible:false,PredictionEligible:false}};
const data = {schema:'bonzobyte.historical-score-display.v1',rows:[
    [sample.l01,sample.l44,sample.l32,sample.l13,sample.l20,compactDay,expected[1],after[1]],
]};

test('the production bundle corrects score only, leaving eligibility, prediction and schedule untouched', () => {
    const history = loadHistoricalScoreDisplay();
    const unrelated = {...sample,l01:123456};
    const result = history.daily(compactDay,[sample,unrelated]);
    assert.deepEqual(result[0],{...sample,l27:after[0],l28:after[1]});
    assert.equal(result[1],unrelated);
    assert.equal(sample.l27,expected[0]);
    const pub = projectPublicDailyMatch(result[0]);
    assert.deepEqual([pub.resultText,pub.resultDetailsText], ['3:0',after[1]]);
    assert.equal(pub.calculationEligible,false);
    assert.equal(pub.predictionEligible,false);
    assert.equal(pub.modelProbabilityPlayer1,null);
});

test('unknown, recent or different source facts are passed through', () => {
    const mismatches = [];
    const history = createHistoricalScoreDisplay(data,(...args) => mismatches.push(args));
    const later = [sample];
    assert.equal(history.daily('20261123',later),later);
    for (const changes of [{l44:99},{l13:67643},{l20:77777},{l02:'2000-01-22'},{l27:'30'},
        {l40:true},{l41:true},{l31:72},{l28:'2:1 6:1 6:2 6:0'}]) {
        const r = {...sample,...changes};
        assert.equal(history.daily(compactDay,[r])[0],r);
    }
    assert.equal(mismatches.length,9);
    assert.throws(() => createHistoricalScoreDisplay({...data,rows:[data.rows[0],data.rows[0]]}));
});

test('match detail decompresses to only the two corrected fields after reading verified bytes', async () => {
    const history = createHistoricalScoreDisplay(data);
    const decoded = Buffer.from(JSON.stringify(detail));
    const payload = {decoded,raw:brotliCompressSync(decoded)};
    const source = {releaseId:'rally-future-release',locateMatchByTp:id => id,
        readVerified:async () => payload};
    const view = history.matchDetailReader(source);
    assert.equal(view.releaseId,source.releaseId);
    assert.equal(view.locateMatchByTp(sample.l01),sample.l01);
    assert.equal(await view.readVerified('matches/12345.br'),payload);
    const response = await view.readVerified(`matches/${sample.l01}.br`);
    assert.deepEqual(JSON.parse(brotliDecompressSync(response.raw)),{...detail,m010:after[0],m011:after[1]});
    assert.deepEqual(JSON.parse(payload.decoded),detail);
    const changed = {...payload,decoded:Buffer.from(JSON.stringify({...detail,m005:98765}))};
    assert.equal(await history.matchDetailReader({...source,readVerified:async()=>changed})
        .readVerified(`matches/${sample.l01}.br`),changed);
    const failure = Error('sealed read failed');
    await assert.rejects(history.matchDetailReader({...source,readVerified:async()=>{throw failure;}})
        .readVerified(`matches/${sample.l01}.br`),{message:failure.message});
});
