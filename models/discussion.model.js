import { Schema, model } from 'mongoose';

export const DISCUSSION_COLLECTIONS = Object.freeze({
    comments: 'discussioncomments', threads: 'discussionthreads', states: 'discussionstates',
    reports: 'discussionreports', spam: 'discussionspam',
});
const options = { autoIndex: false, autoCreate: false, versionKey: false };
const objectId = Schema.Types.ObjectId;
const comment = new Schema({
    matchTPId: Number, sequence: Number, userId: objectId, body: String, createdAt: Date,
    replyToId: objectId, deleted: Boolean, hidden: Boolean,
    clientRequestId: String, requestHash: String, reportRevision: Number,
}, options);
comment.index({ matchTPId: 1, sequence: 1 }, { unique: true });
comment.index({ userId: 1, clientRequestId: 1 }, { unique: true,
    partialFilterExpression: { userId: { $type: 'objectId' }, clientRequestId: { $type: 'string' } } });
comment.index({ matchTPId: 1, deleted: 1, hidden: 1, sequence: 1 });
// Erasure searches by user alone and must not depend on a partial index.
comment.index({ userId: 1 });
// Cover the owner's visible participation without indexing comment bodies.
comment.index({ userId: 1, deleted: 1, hidden: 1, matchTPId: 1, createdAt: -1 });
const thread = new Schema({ _id: Number, latestSequence: Number, lastActivityAt: Date, title: String }, options);
const state = new Schema({ userId: objectId, matchTPId: Number, following: Boolean,
    manualFollowing: Boolean, firstPostAt: Date, readThrough: Number, fetchedThrough: Number }, options);
state.index({ userId: 1, matchTPId: 1 }, { unique: true });
state.index({ userId: 1, following: 1 });
const report = new Schema({ userId: objectId, authorId: objectId, commentId: objectId,
    matchTPId: Number, reason: String, createdAt: Date }, options);
report.index({ userId: 1, commentId: 1 }, { unique: true });
report.index({ authorId: 1 });
report.index({ commentId: 1 });
const spam = new Schema({ _id: objectId, posts: [Date], reports: [Date] }, options);

export const DiscussionComment = model('DiscussionComment', comment, DISCUSSION_COLLECTIONS.comments);
export const DiscussionThread = model('DiscussionThread', thread, DISCUSSION_COLLECTIONS.threads);
export const DiscussionState = model('DiscussionState', state, DISCUSSION_COLLECTIONS.states);
export const DiscussionReport = model('DiscussionReport', report, DISCUSSION_COLLECTIONS.reports);
export const DiscussionSpam = model('DiscussionSpam', spam, DISCUSSION_COLLECTIONS.spam);
export const discussionModels = [DiscussionComment, DiscussionThread, DiscussionState, DiscussionReport, DiscussionSpam];
