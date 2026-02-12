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
  }
}, { timestamps: true });

export default model("FavouriteMatch", favouriteMatchSchema );