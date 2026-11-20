import { model, Schema } from 'mongoose';
import { discussionModels } from './discussion.model.js';

// Separate namespace: a forum ID can never grant match participation or DM rights.
export const COMMUNITY_COLLECTIONS = Object.freeze({ comments: 'communitycomments', threads: 'communitythreads',
    states: 'communitystates', reports: 'communityreports', spam: 'communityspam', reactions: 'communityreactions' });
export const communityModels = discussionModels.map((source, index) => {
    const schema = source.schema.clone();
    if (index === 0) schema.add({ editedAt: Date, editVersion: Number, reactionRevision: Number });
    if (index === 1) {
        schema.add({ category: String, language: String, userId: Schema.Types.ObjectId, createdAt: Date, removed: Boolean,
            pinned: Boolean, pinnedAt: Date, editFence: Number, reactionFence: Number });
        schema.index({ category: 1, removed: 1, lastActivityAt: -1, _id: -1 });
        schema.index({ userId: 1 });
    }
    if (index === 4) schema.add({ edits: [Date], reactions: [Date] });
    return model(`Community${index}`, schema, Object.values(COMMUNITY_COLLECTIONS)[index]);
});
const reaction = new Schema({ commentId: Schema.Types.ObjectId, matchTPId: Number,
    userId: Schema.Types.ObjectId, authorId: Schema.Types.ObjectId, createdAt: Date },
    { autoIndex: false, autoCreate: false, versionKey: false });
reaction.index({ commentId: 1, userId: 1 }, { unique: true });
reaction.index({ userId: 1 });
reaction.index({ authorId: 1 });
reaction.index({ matchTPId: 1 });
export const CommunityReaction = model('CommunityReaction', reaction, COMMUNITY_COLLECTIONS.reactions);
