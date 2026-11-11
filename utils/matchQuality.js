// This is a transport guard, not a second tennis-score validator.
// The canonical writer owns the persisted decision and evidence fingerprint.
export function applyMatchQuality(row) {
    const q = row.q;
    // An explicitly supplied details decision is authoritative, including missing fields.
    const status = q != null ? (q.status ?? 'NotAssessed') : (row.qualityStatus ?? row.l38);
    if (status == null) return row; // Archived legacy contract.
    const prediction = q != null ? q.predictionEligible : (row.predictionEligible ?? row.l41);
    const calculation = q != null ? q.calculationEligible : (row.calculationEligible ?? row.l40);
    const held = !['Validated', 'Incomplete', 'NonRatedOutcome'].includes(status);
    const predictionAllowed = !held && status !== 'NonRatedOutcome' && prediction === true;
    const result = {
        ...row,
        qualityStatus: status,
        qualityReason: q?.reason ?? row.qualityReason ?? row.l39 ?? 'quality-assessment-required',
        qualityPolicyVersion: q?.policyVersion ?? row.qualityPolicyVersion ?? row.l42,
        calculationEligible: !held && status === 'Validated' && calculation === true,
        predictionEligible: predictionAllowed,
    };
    if ('l38' in result) {
        result.l38 = status;
        result.l39 = result.qualityReason;
        result.l40 = result.calculationEligible;
        result.l41 = predictionAllowed;
        result.l42 = result.qualityPolicyVersion;
    }
    if (!predictionAllowed) {
        for (const name of ['l31', 'm655', 'n', 'probabilityText', 'probLeft', 'probRight', 'winProbabilityPlayer1NN', 'winProbabilityPlayer2NN',
            'modelProbabilityPlayer1', 'modelProbabilityPlayer2', 'player1WinProbabilityNN',
            'player2WinProbabilityNN', 'winProbabilityNN']) {
            if (name in result) result[name] = null;
        }
    }
    return result;
}
