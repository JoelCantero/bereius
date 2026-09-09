/**
 * The web app has no per-document route: it opens one from the list view, with
 * the identifier in the fragment. Confirmed against a real estimate; the
 * invoice shape is deliberately absent until it is confirmed the same way.
 */
export function holdedEstimateUrl(estimateId: string): string {
  return `https://app.holded.com/sales/estimates#open:estimate-${estimateId}`;
}
