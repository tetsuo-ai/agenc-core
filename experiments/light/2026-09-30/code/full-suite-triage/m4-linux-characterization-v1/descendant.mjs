const helper = await import(process.env.M4_CHARACTERIZATION_HELPER);
process.send({ scopeAbsent: process.env.AGENC_TEST_M4_DIAGNOSTIC_SCOPE === undefined,
  emitterAbsent: helper.mark('fixture_entry') === false, ipcWorks: true }, error => {
  if (error) process.exitCode = 1;
  process.disconnect();
});
