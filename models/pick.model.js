import { Schema, model } from "mongoose";

const pickSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  matchTPId: { type: Number, required: true }, // iz MatchActive
  pickedPlayerTPId: { type: Number, required: true },
  oddsAtPickTime: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});

pickSchema.index({ userId: 1, matchTPId: 1 }, { unique: true });

export default model("Pick", pickSchema);