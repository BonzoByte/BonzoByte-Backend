"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TennisScoring = void 0;
const other = (side) => side === 0 ? 1 : 0;
/** Pure scorekeeper. Match format is best of three tie-break sets, with advantage games. */
class TennisScoring {
    format;
    points = [0, 0];
    games = [0, 0];
    sets = [0, 0];
    completedSets = [];
    server = 0;
    winner = null;
    isTieBreak = false;
    lastAward = null;
    totalPoints = 0;
    tieBreakFirstServer = 0;
    constructor(format = 'challenge') {
        this.format = format;
    }
    get pointLabels() {
        if (this.format === 'challenge' || this.isTieBreak)
            return [String(this.points[0]), String(this.points[1])];
        if (this.points[0] >= 3 && this.points[1] >= 3) {
            const difference = this.points[0] - this.points[1];
            return difference === 0 ? ['40', '40'] : difference > 0 ? ['AD', '40'] : ['40', 'AD'];
        }
        const labels = ['0', '15', '30', '40'];
        return [labels[Math.min(3, this.points[0])], labels[Math.min(3, this.points[1])]];
    }
    award(side) {
        if (this.winner !== null)
            return false;
        this.points[side]++;
        this.totalPoints++;
        this.lastAward = 'point';
        if (this.format === 'challenge') {
            this.server = this.tieBreakServer(this.points[0] + this.points[1], 0);
            if (this.points[side] >= 7 && this.points[side] - this.points[other(side)] >= 2) {
                this.winner = side;
                this.lastAward = 'match';
            }
            return true;
        }
        if (this.isTieBreak) {
            if (this.points[side] >= 7 && this.points[side] - this.points[other(side)] >= 2) {
                this.games[side]++;
                this.server = other(this.tieBreakFirstServer);
                this.finishSet(side, [...this.points]);
            }
            else
                this.server = this.tieBreakServer(this.points[0] + this.points[1], this.tieBreakFirstServer);
            return true;
        }
        if (this.points[side] < 4 || this.points[side] - this.points[other(side)] < 2)
            return true;
        this.points = [0, 0];
        this.games[side]++;
        this.lastAward = 'game';
        this.server = other(this.server);
        if (this.games[side] >= 6 && this.games[side] - this.games[other(side)] >= 2)
            this.finishSet(side, null);
        else if (this.games[0] === 6 && this.games[1] === 6) {
            this.isTieBreak = true;
            this.tieBreakFirstServer = this.server;
        }
        return true;
    }
    tieBreakServer(pointsPlayed, first) {
        return pointsPlayed === 0 || Math.floor((pointsPlayed - 1) / 2) % 2 === 1 ? first : other(first);
    }
    finishSet(side, tieBreak) {
        this.completedSets.push({ games: [...this.games], tieBreak });
        this.sets[side]++;
        this.points = [0, 0];
        this.games = [0, 0];
        this.isTieBreak = false;
        this.lastAward = 'set';
        if (this.sets[side] === 2) {
            this.winner = side;
            this.lastAward = 'match';
        }
    }
}
exports.TennisScoring = TennisScoring;
