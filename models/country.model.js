import { Schema, model } from "mongoose";

const countrySchema = new Schema({
  _id: { type: Number, required: true, match: /^[1-9]{1, 3}$/},
  countryShort: { type: String, required: true, minlength: 3, maxlength: 3, match: /^[A-Z]{3}$/ },
  countryFull: { type: String, required: true }
});

export default model("Country", countrySchema);