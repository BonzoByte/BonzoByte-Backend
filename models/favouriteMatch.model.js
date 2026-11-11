import { Schema, model } from "mongoose";

const favouriteMatchSchema  = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  matchTPId: {
    type: Number,
    required: true,
    validate: value => Number.isSafeInteger(value) && value > 0,
  }
}, { timestamps: true, autoIndex: false, autoCreate: false });

// Explicit startup initialization handles legacy duplicates without deleting them.
favouriteMatchSchema.index({ userId: 1, matchTPId: 1 }, { unique: true, name: 'favourite_match_owner_id_unique' });

export default model("FavouriteMatch", favouriteMatchSchema );
