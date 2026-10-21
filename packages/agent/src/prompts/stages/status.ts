/** The status text itself is rendered by code; the model only has to make the one call. */
export const STATUS_INSTRUCTIONS =
  'Call reply_request_status with {} exactly once. Its server-generated text is a separate acknowledgement, not a rewrite of a declined recommendation. Do not call any other tool or finish without the status call.';
