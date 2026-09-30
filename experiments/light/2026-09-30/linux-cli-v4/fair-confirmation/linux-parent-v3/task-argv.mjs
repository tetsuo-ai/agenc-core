// Ordinary CLI argv for the single fake-response task. `-p` is boolean and the
// canonical tokenizer (runtime/src/bin/cli-option-region.ts) ends the option
// region at the first positional token, so every startup flag must precede the
// prompt. `--` ends the option region explicitly; it is not part of the prompt.
export function taskArgv({tripwire,calendar,cli,config,task}) {
  return ['--require',tripwire,'--require',calendar,cli,'-p','--light','--provider','openai','--model','gpt-6-luna',
    '--config',config,'--permission-mode','default','--',task];
}
