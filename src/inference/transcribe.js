export async function transcribe(/* input */) {
  // Voice disabled: return empty text so routes won't break.
  return { text: "", durationSec: 0, language: "en" };
}
export default transcribe;
