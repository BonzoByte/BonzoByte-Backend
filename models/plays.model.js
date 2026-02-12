import { Schema, model } from "mongoose";

const playsSchema = new Schema({
  _id: { type: Number, required: true},
  plays: { type: String, required: true, minlength: 3, maxlength: 20},
});

export default model("Plays", playsSchema);