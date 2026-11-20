import { discussionFollowingPipeline } from './discussionStore.js';

/** Same canonical read-watermark rules, with deleted/closed forum topics omitted. */
export function communityFollowingPipeline(userId, names, page) {
    const pipeline = discussionFollowingPipeline(userId, names, page);
    const pending = pipeline.find(step => step.$lookup?.as === 'pending').$lookup.pipeline;
    pending.splice(1, 0, { $sort: { sequence: 1 } });
    pending.at(-1).$project.sequence = 1;
    const projectionIndex = pipeline.findIndex(step => step.$project);
    pipeline.splice(projectionIndex, 0,
        { $match: { 'thread.0.removed': false, 'thread.0.category': { $in: ['matches','play','equipment','terrace'] } } },
        { $lookup: { from: 'users', let: { author: { $arrayElemAt: ['$thread.userId', 0] } }, pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$author'] }, 'accountClosure.requestedAt': { $exists: false } } },
            { $project: { _id: 1 } },
        ], as: 'activeTopicAuthor' } },
        { $match: { 'activeTopicAuthor.0': { $exists: true } } });
    const project = pipeline.find(step => step.$project).$project;
    project.category = { $arrayElemAt: ['$thread.category', 0] };
    project.language = { $arrayElemAt: ['$thread.language', 0] };
    project.firstUnreadSequence = { $ifNull: [{ $arrayElemAt: ['$pending.sequence', 0] }, null] };
    return pipeline;
}
