import { Schema, model } from "mongoose";

const favouritePlayerSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  playerTPID: {
    type: Number,
    required: true,
  }
}, { timestamps: true });

export default model("FavouritePlayer", favouritePlayerSchema);