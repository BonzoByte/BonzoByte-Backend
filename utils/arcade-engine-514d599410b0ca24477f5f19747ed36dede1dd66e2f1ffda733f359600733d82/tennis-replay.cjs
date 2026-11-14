"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArcadeRecorder = exports.ARCADE_REPLAY = void 0;
exports.quantizedStep = quantizedStep;
exports.applyArcadeCommand = applyArcadeCommand;
exports.replayArcade = replayArcade;
const tennis_3d_engine_1 = require("./tennis-3d-engine.cjs");
const tennis_skill_1 = require("./tennis-skill.cjs");
exports.ARCADE_REPLAY = { bytesPerFrame: 7, maxFrames: 90000, maxSeconds: 1200, maxCommands: 6 };
const shots = [null, 'drive', 'lob', 'smash'];
function quantizedStep(seconds) { return Math.round(Math.max(0, Math.min(.05, seconds)) * 1e6) / 1e6; }
function applyArcadeCommand(game, command) {
    if (command === 1)
        game.armServe();
    else if (command === 2)
        game.cancelServeCharge();
    else
        game.setServeAim(command - 4);
}
class ArcadeRecorder {
    bytes = new Uint8Array(exports.ARCADE_REPLAY.bytesPerFrame * exports.ARCADE_REPLAY.maxFrames);
    commands = [];
    frames = 0;
    seconds = 0;
    valid = true;
    command(value) {
        if (this.commands.at(-1) === value)
            return;
        if (this.commands.length >= exports.ARCADE_REPLAY.maxCommands) {
            this.valid = false;
            return;
        }
        this.commands.push(value);
    }
    capture(seconds, input) {
        if (!this.valid)
            return;
        seconds = quantizedStep(seconds);
        this.seconds += seconds;
        if (this.frames >= exports.ARCADE_REPLAY.maxFrames || this.seconds > exports.ARCADE_REPLAY.maxSeconds) {
            this.valid = false;
            return;
        }
        const pos = this.frames++ * 7, micros = Math.round(seconds * 1e6);
        this.bytes[pos] = micros & 255;
        this.bytes[pos + 1] = micros >>> 8;
        this.bytes[pos + 2] = Number(input.left) | Number(input.right) << 1 | Number(input.forward) << 2 | Number(input.back) << 3 | Number(input.jump) << 4;
        const aim = input.aim === undefined ? 0 : input.aim === -1 ? 1 : input.aim === 0 ? 2 : 3;
        this.bytes[pos + 3] = shots.indexOf(input.shot) | aim << 2 | Number(!!input.aiming) << 4;
        for (let i = 0; i < 3; i++)
            this.bytes[pos + 4 + i] = (this.commands[2 * i] ?? 0) | (this.commands[2 * i + 1] ?? 0) << 4;
        this.commands = [];
    }
    exportBytes() {
        if (!this.valid || !this.frames)
            throw Error('Replay not available');
        return this.bytes.slice(0, this.frames * 7);
    }
}
exports.ArcadeRecorder = ArcadeRecorder;
function replayArcade(bytes, config) {
    if (!bytes.length || bytes.length % 7 || bytes.length > exports.ARCADE_REPLAY.maxFrames * 7 ||
        !Number.isFinite(config.strength) || config.strength < 0 || config.strength > 1 || !['grass', 'clay', 'hard'].includes(config.surface))
        throw Error('Invalid replay');
    const game = new tennis_3d_engine_1.Tennis3DEngine((0, tennis_skill_1.arcadeRandom)(config.seed), 'challenge');
    game.assist = true;
    game.opponentStrength = config.strength;
    game.start(config.surface, 'normal', 'challenge');
    let seconds = 0;
    for (let pos = 0; pos < bytes.length; pos += 7) {
        if (game.phase === 'over')
            throw Error('Replay continues after completion');
        const micros = bytes[pos] | bytes[pos + 1] << 8, flags = bytes[pos + 2], stroke = bytes[pos + 3];
        if (micros > 50000 || flags > 31 || stroke > 31)
            throw Error('Invalid replay controls');
        seconds += micros / 1e6;
        if (seconds > exports.ARCADE_REPLAY.maxSeconds)
            throw Error('Replay exceeds duration');
        let ended = false;
        for (let i = 0; i < 6; i++) {
            const command = (bytes[pos + 4 + Math.floor(i / 2)] >>> ((i % 2) * 4)) & 15;
            if (!command) {
                ended = true;
                continue;
            }
            if (ended || command > 5)
                throw Error('Invalid replay command');
            applyArcadeCommand(game, command);
        }
        const aim = (stroke >>> 2) & 3;
        game.update(micros / 1e6, { left: !!(flags & 1), right: !!(flags & 2), forward: !!(flags & 4), back: !!(flags & 8), jump: !!(flags & 16),
            shot: shots[stroke & 3], aim: aim === 0 ? undefined : aim === 1 ? -1 : aim === 2 ? 0 : 1, aiming: !!(stroke & 16) });
    }
    if (game.phase !== 'over' || game.winner === null)
        throw Error('Replay is incomplete');
    return { winner: game.winner, score: [...game.score], seconds, frames: bytes.length / 7, bestRally: game.bestRally };
}
