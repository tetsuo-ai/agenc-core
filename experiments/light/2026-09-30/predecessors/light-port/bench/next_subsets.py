"""Run the two frozen catalog variants after the preserved event subset ends."""
import pathlib, subprocess, time
root=pathlib.Path(__file__).resolve().parent.parent
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
probe="find ~/claude-agenc-work/light-port/runs -path '*candidate-events-subset*/result.json' | wc -l"
while True:
    result=subprocess.run(ssh+[probe],capture_output=True,text=True,check=True)
    if int(result.stdout)==8:
        time.sleep(2)
        break
    time.sleep(15)
for phase, catalog in [('candidate-files-subset','0'),('candidate-catalog-subset','1')]:
    print('Launching '+phase,flush=True)
    with (root/'evidence'/f'{phase}-launch.log').open('w') as log:
        subprocess.run(['bash',str(root/'bench/run-cohort.sh'),phase,'core-catalog',
                        '01-chunked-strict,04-count-by,06-key-rotation-map,12-partition-map','1','1',catalog,'harness-next'],
                       cwd=root,stdout=log,stderr=subprocess.STDOUT,check=True)
    print('Finished '+phase,flush=True)
