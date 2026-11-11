import { Schema, model } from "mongoose";

const surfaceSchema = new Schema({
  _id: { type: Number, required: true, match: /^[1-9]{1}$/},
  surface: { type: String, required: true, minlength: 3, maxlength: 7 },
});

export default model("Surface", surfaceSchema);