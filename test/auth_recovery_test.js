const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const schema=fs.readFileSync(path.join(root,'db','schema.sql'),'utf8');
const env=fs.readFileSync(path.join(root,'.env.example'),'utf8');
const checks=[
  ['/api/auth/signup',server],
  ['/api/auth/login',server],
  ['/api/auth/reset-password',server],
  ['UPDATE users SET password_hash=$1, updated_at=NOW()',server],
  ['UPDATE sessions SET ended_at=NOW(), last_seen_at=NOW()',server],
  ['resetForm',html],
  ['authThemeToggle',html],
  ['data-password-toggle="loginPassword"',html],
  ['overflow-y:auto!important',html],
];
for(const [needle,source] of checks) assert(source.includes(needle),`Missing auth recovery feature: ${needle}`);
assert(!html.includes('id="resetCode"'),'Direct recovery UI must not show a verification code field');
assert(!html.includes('id="forgotForm"'),'Recovery should go directly to the new-password form');
assert(html.includes('id="resetUsername"') && html.includes('id="resetPassword"') && html.includes('id="resetConfirm"'),'Recovery must expose username, new password and confirm password fields');
assert(html.includes('openPasswordRecovery'),'Forgot password should open the direct reset form immediately');
console.log('AUTH RECOVERY / LOGIN UX STATIC TESTS PASSED');
