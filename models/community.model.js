import { model, Schema } from 'mongoose';
import { discussionModels } from './discussion.model.js';

// Separate namespace: a forum ID can never grant match participation or DM rights.
export const COMMUNITY_COLLECTIONS = Object.freeze({ comments: 'communitycomments', threads: 'communitythreads',
    states: 'communitystates', reports: 'communityreports', spam: 'communityspam' });
export const communityModels = discussionModels.map((source, index) => {
    const schema = source.schema.clone();
    if (index === 1) {
        schema.add({ category: String, language: String, userId: Schema.Types.ObjectId, createdAt: Date, removed: Boolean });
        schema.index({ category: 1, removed: 1, lastActivityAt: -1, _id: -1 });
        schema.index({ userId: 1 });
    }
    return model(`Community${index}`, schema, Object.values(COMMUNITY_COLLECTIONS)[index]);
});
