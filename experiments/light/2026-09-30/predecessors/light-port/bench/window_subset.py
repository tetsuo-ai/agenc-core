import pathlib, subprocess, time
root=pathlib.Path(__file__).resolve().parent.parent
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
while True:
    p=subprocess.run(ssh+["find ~/claude-agenc-work/light-port/runs -path '*candidate-catalog-subset*/result.json' | wc -l"],capture_output=True,text=True,check=True)
    if int(p.stdout)==8:
        time.sleep(2)
        break
    time.sleep(15)
with (root/'evidence/window-subset-launch.log').open('w') as log:
    subprocess.run(['bash',str(root/'bench/run-cohort.sh'),'candidate-window-subset','core-window',
                    '01-chunked-strict,04-count-by,06-key-rotation-map,12-partition-map','1','1','0','harness-next'],
                   cwd=root,stdout=log,stderr=subprocess.STDOUT,check=True)
