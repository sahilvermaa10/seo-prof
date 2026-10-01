# Final UI + Quiz Fix

- Fixed quiz answer key mismatch (`quiz_q1` vs `q1`) so 20/20 can submit.
- Submission now normalizes answers from question IDs and returns the server score/review.
- Preserved deterministic server-side grading; AI is not used as the authority for correctness.
- Added final light/dark theme contract for all common cards, panels, inputs, tables, file inputs, result boxes and quiz controls.
- Fixed dark-mode pale inputs with nearly invisible text and light-mode white-on-white controls.
- Quiz submit/review buttons remain visible according to quiz state.
