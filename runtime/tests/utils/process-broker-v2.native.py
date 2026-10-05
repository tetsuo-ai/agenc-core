"""Defensive native protocol fixtures. Invoked by the vitest wrapper in a container."""
from pathlib import Path
import ctypes,fcntl,json,os,select,signal,struct,subprocess,sys,tempfile,time,unittest
ROOT=Path(__file__).resolve().parents[2]
TEMP=tempfile.TemporaryDirectory(prefix='agenc-broker-v2-test-')
D=Path(TEMP.name)
BROKER=D/'broker';TARGET=D/'target'
subprocess.run(['cc','-O2','-std=c11','-Wall','-Wextra','-Werror','-o',str(BROKER),str(ROOT/'native/agenc-process-broker.c')],check=True)
(D/'target.c').write_text(r'''
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
int main(int argc,char **argv){
 (void)argc;(void)argv;
 const char *wait = getenv("FIXTURE_WAIT_PATH");
 if(wait) for(int i=0;access(wait,F_OK)!=0 && i<5000;i++) usleep(1000);
 const char *effect = getenv("FIXTURE_EFFECT_PATH");
 if(effect) {
  int marker=open(effect,O_WRONLY|O_CREAT|O_APPEND,0600);
  if(marker<0 || write(marker,"X",1)!=1 || close(marker)!=0) return 3;
 }
 puts("EXEC");
 for(int fd=3;fd<32;fd++) if(fcntl(fd,F_GETFD)>=0){
   printf("FD=%d SEALS=%d OFFSET=%ld\n",fd,fcntl(fd,F_GET_SEALS),(long)lseek(fd,0,SEEK_CUR));
   unsigned char bytes[8];ssize_t n=read(fd,bytes,8);
   printf("READ=%ld FIRST=%u\n",(long)n,n>0?bytes[0]:0);
   errno=0;ssize_t w=pwrite(fd,"X",1,0);printf("WRITE=%ld ERR=%d\n",(long)w,errno);
 }
 return 0;
}
''')
subprocess.run(['cc','-O2','-Wall','-Wextra','-Werror','-o',str(TARGET),str(D/'target.c')],check=True)

def frame(owner=None,data=None,env=(),args=None):
 program=str(TARGET);args=args if args is not None else (['--seccomp','3','--','fixture'] if data is not None else ['--','fixture'])
 argv=[program,*args];strings=[program,*argv,*env]
 record=b'' if data is None else struct.pack('>IIII',5,3,1,len(data))
 body=record+b''.join(x.encode()+b'\0' for x in strings)+(data or b'')
 return b'AGB2'+struct.pack('>IIIIII',len(body),len(argv),len(env),0,int(data is not None),owner or os.getpid())+body+b'\xa5'

def invoke(payload,source=None,extra=False,hold=False,prefix_stop=False,timeout=13,on_ready=None,cancel_pending=False):
 # Own fork keeps expectedOwner exactly this test controller. Duplicate all
 # setup descriptors high before assigning the broker's fixed slots.
 out_r,out_w=os.pipe();status_r,status_w=os.pipe();boot_r,boot_w=os.pipe()
 null=os.open('/dev/null',os.O_RDONLY)
 sources=[null,out_w,out_w,status_w,boot_r]+([source] if source is not None else [])
 copies=[fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,40) for fd in sources]
 pid=os.fork()
 if pid==0:
  try:
   for fd,old in enumerate(copies):os.dup2(old,fd)
   if extra:os.dup2(0,6)
   keep=7 if extra else len(copies)
   os.closerange(keep,4096)
   if prefix_stop:os.kill(os.getpid(),signal.SIGSTOP)
   os.execv(str(BROKER),[str(BROKER),'--bootstrap-v2'])
  finally:os._exit(126)
 for fd in copies+[null,out_w,status_w,boot_r]:os.close(fd)
 if prefix_stop:
  os.waitpid(pid,os.WUNTRACED)
  os.kill(pid,signal.SIGCONT)
 try:
  if payload:os.write(boot_w,payload)
 except BrokenPipeError:pass
 if cancel_pending:
  # The complete frame is not committed until EOF. Allow initialization,
  # suspend it, then make cancellation pending before EOF and continuation.
  time.sleep(.05);os.kill(pid,signal.SIGSTOP);os.waitpid(pid,os.WUNTRACED)
  os.kill(pid,signal.SIGTERM)
 if not hold:os.close(boot_w);boot_w=None
 if cancel_pending:os.kill(pid,signal.SIGCONT)
 prefix=b''
 if on_ready is not None:
  ready,_,_=select.select([status_r],[],[],3)
  assert ready,'no status before source mutation'
  prefix=os.read(status_r,1);assert prefix==b'S',prefix
  on_ready()
 end=time.monotonic()+timeout;status=None
 while time.monotonic()<end:
  got,status=os.waitpid(pid,os.WNOHANG)
  if got:break
  time.sleep(.002)
 else:
  os.kill(pid,signal.SIGKILL);os.waitpid(pid,0);raise AssertionError('broker did not settle finitely')
 if boot_w is not None:os.close(boot_w)
 output=os.read(out_r,65536);proof=prefix+os.read(status_r,1024)
 os.close(out_r);os.close(status_r)
 return os.waitstatus_to_exitcode(status),output,proof

class Protocol(unittest.TestCase):
 def setUp(self):self.file=tempfile.TemporaryFile(dir=D)
 def tearDown(self):self.file.close()
 def source(self,data):self.file.write(data);self.file.flush();return self.file.fileno()
 def rejected(self,data,**kwargs):
  code,out,proof=invoke(data,**kwargs);self.assertNotIn(b'EXEC',out);self.assertEqual(code,125);self.assertNotIn(b'S',proof)
 def test_capabilities(self):
  self.assertEqual(subprocess.check_output([str(BROKER),'--describe-protocol']),b'AGB2 owner-pid seccomp-snapshot-sealed-v1\n')
 def test_no_descriptor(self):
  code,out,proof=invoke(frame());self.assertEqual((code,proof),(0,b'SC'));self.assertEqual(out,b'EXEC\n')
 def test_sealed_snapshot_and_independent_offset(self):
  data=bytes(range(8));fd=self.source(data);os.lseek(fd,7,os.SEEK_SET)
  code,out,proof=invoke(frame(data=data),source=fd)
  self.assertEqual((code,proof),(0,b'SC'));self.assertIn(b'FD=3 SEALS=15 OFFSET=0',out)
  self.assertIn(b'FIRST=0',out);self.assertIn(b'WRITE=-1 ERR=1',out);self.assertNotIn(b'FD=5',out);self.assertNotIn(b'FD=6',out)
  self.assertEqual(os.lseek(fd,0,os.SEEK_CUR),7)
 def test_source_mutation_after_snapshot(self):
  data=b'12345678';fd=self.source(data);release=D/'mutation-release'
  def mutate():
   os.pwrite(fd,b'abcdefgh',0);release.touch()
  try:
   code,out,proof=invoke(frame(data=data,env=(f'FIXTURE_WAIT_PATH={release}',)),source=fd,on_ready=mutate)
   self.assertEqual((code,proof),(0,b'SC'));self.assertIn(b'FIRST=49',out)
   self.assertIn(b'SEALS=15',out);self.assertEqual(os.pread(fd,8,0),b'abcdefgh')
  finally:release.unlink(missing_ok=True)
 def test_pending_cancel_before_eof(self):
  self.rejected(frame(),cancel_pending=True)
 def test_every_truncation(self):
  data=frame()
  for cut in range(len(data)):
   with self.subTest(cut=cut):self.rejected(data[:cut])
 def test_header_contract(self):
  for offset,values in [(4,[0,2097153]),(8,[0,65536]),(12,[65536]),(16,[1]),(20,[2]),(24,[0,1,0xffffffff,os.getpid()+999999])]:
   for value in values:
    b=bytearray(frame());struct.pack_into('>I',b,offset,value)
    with self.subTest(offset=offset,value=value):self.rejected(b)
 def test_unknown_version_commit_extra(self):
  b=frame()
  for x in [b'BAD!'+b[4:],b[:-1]+b'X',b+b'X']:self.rejected(x)
 def test_map_contract(self):
  data=b'12345678';fd=self.source(data)
  for offset,values in [(28,[0,1,2,3,4,6]),(32,[0,1,2,4,5]),(36,[0,2]),(40,[0,7,9,32776])]:
   for value in values:
    b=bytearray(frame(data=data));struct.pack_into('>I',b,offset,value)
    with self.subTest(offset=offset,value=value):self.rejected(b,source=fd)
 def test_wrong_source_bytes_size_missing(self):
  data=b'12345678';fd=self.source(b'abcdefgh')
  self.rejected(frame(data=data),source=fd);self.rejected(frame(data=data))
  self.file.write(b'x');self.file.flush();self.rejected(frame(data=data),source=fd)
 def test_source_types(self):
  data=b'12345678'
  for path in ['/dev/null',str(D)]:
   fd=os.open(path,os.O_RDONLY)
   try:self.rejected(frame(data=data),source=fd)
   finally:os.close(fd)
  r,w=os.pipe()
  try:self.rejected(frame(data=data),source=r)
  finally:os.close(r);os.close(w)
 def test_extra_inherited_fd(self):self.rejected(frame(),extra=True)
 def test_descriptor_argv_mismatch(self):
  self.rejected(frame(args=['--seccomp','3','--','fixture']))
  data=b'12345678';fd=self.source(data)
  for args in [['--','fixture'],['--seccomp','4','--','fixture'],['--seccomp','3','--seccomp','3','--','fixture'],['--seccomp','3','--info-fd','3','--','fixture']]:self.rejected(frame(data=data,args=args),source=fd)
 def test_environment(self):
  for env in [('=x',),('BAD',),('A=x','A=y')]:self.rejected(frame(env=env))
 def test_all_descriptor_roles_rejected(self):
  for option in ['--add-seccomp-fd','--ro-bind-fd','--bind-fd','--args','--file','--bind-data','--ro-bind-data','--sync-fd','--info-fd','--json-status-fd','--userns','--userns2','--pidns','--block-fd','--userns-block-fd']:
   with self.subTest(option=option):
    self.rejected(frame(args=[option,'3','--','fixture']))
    self.rejected(frame(args=[option+'=3','--','fixture']))
  self.rejected(frame(args=['--seccomp=3','--','fixture']))
 def test_missing_eof_deadline(self):self.rejected(frame(),hold=True)
 def test_repeat_no_parent_fd_leaks(self):
  n=len(list(Path('/proc/self/fd').iterdir()))
  for i in range(20):self.assertEqual(invoke(frame())[0],0)
  self.assertEqual(len(list(Path('/proc/self/fd').iterdir())),n)

def adoption(subreaper):
 # Controller dies after handing over the whole frame, while the broker
 # process is paused before exec/initialization. Observe both adopter kinds.
 libc=ctypes.CDLL(None,use_errno=True)
 if subreaper:assert libc.prctl(36,1,0,0,0)==0
 read_pid,write_pid=os.pipe();out_r,out_w=os.pipe();stat_r,stat_w=os.pipe()
 controller=os.fork()
 if controller==0:
  try:
   br,bw=os.pipe();null=os.open('/dev/null',os.O_RDONLY)
   sources=[null,out_w,out_w,stat_w,br];copies=[fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,40) for fd in sources]
   broker=os.fork()
   if broker==0:
    for fd,old in enumerate(copies):os.dup2(old,fd)
    os.closerange(5,4096);os.kill(os.getpid(),signal.SIGSTOP)
    os.execv(str(BROKER),[str(BROKER),'--bootstrap-v2']);os._exit(126)
   os.waitpid(broker,os.WUNTRACED);os.write(bw,frame(owner=os.getpid()));os.close(bw)
   os.write(write_pid,str(broker).encode());os._exit(0)
  finally:os._exit(126)
 os.close(write_pid);os.close(out_w);os.close(stat_w)
 broker=int(os.read(read_pid,64));os.close(read_pid);os.waitpid(controller,0)
 os.kill(broker,signal.SIGCONT)
 ready,_,_=select.select([out_r],[],[],3);assert ready,'adopted broker did not exit'
 output=os.read(out_r,4096);proof=os.read(stat_r,1024);os.close(out_r);os.close(stat_r)
 assert b'EXEC' not in output and b'S' not in proof,(output,proof)
 if subreaper:
  _,st=os.waitpid(broker,0);assert os.waitstatus_to_exitcode(st)==125
  assert libc.prctl(36,0,0,0,0)==0

class Owner(unittest.TestCase):
 def test_adopted_by_init(self):adoption(False)
 def test_adopted_by_noninit_subreaper(self):adoption(True)

if __name__=='__main__':
 unittest.main(verbosity=2)
