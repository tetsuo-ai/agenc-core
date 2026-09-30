import importlib.util
import json
import os
import pathlib
import sys
import unittest
import tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('replay',pathlib.Path(__file__).with_name('replay.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ReplayTests(unittest.TestCase):
    def test_cache_revision_validation_precedes_path_resolution(self):
        invalid = ('', '../outside', '/tmp/cache', 'a/b', '--help', 'a'*39,
                   'a'*41, 'g'*40, 'A'*40, 'a'*40+'\n', None, 42, ['a'*40])
        for value in invalid:
            with self.subTest(value=value), patch.object(m, 'confined_path') as resolve:
                with self.assertRaises(ValueError):m.repository_cache_path('/cache', value)
                resolve.assert_not_called()
    def test_cache_revision_rejects_symlink_selector(self):
        revision='a'*40
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)/'root';root.mkdir()
            self.assertEqual(m.repository_cache_path(root,revision),root.resolve()/revision)
            (root/revision).symlink_to(pathlib.Path(directory))
            with self.assertRaises(ValueError):m.repository_cache_path(root,revision)
    def test_confined_paths_reject_absolute_traversal_and_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)/'root';root.mkdir()
            (root/'escape').symlink_to(pathlib.Path(directory))
            for value in ('../outside', '/tmp/outside', 'escape/outside', '.'):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    m.confined_path(root,value)
            self.assertEqual(m.confined_path(root,'setup/task.py'),root.resolve()/'setup/task.py')
    def test_selector_links_are_rejected_without_resolving_or_reading_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            base=pathlib.Path(directory).resolve();root=base/'root';root.mkdir()
            inside=root/'inside';inside.mkdir()
            outside=base/'root-other';outside.mkdir()
            (root/'internal').symlink_to(inside)
            (root/'external').symlink_to(outside)
            (root/'dangling').symlink_to(base/'missing')
            (root/'chain').symlink_to(root/'external')
            (root/'equal').symlink_to(root)
            real_resolve=pathlib.Path.resolve
            def resolve_trusted_only(path, *args, **kwargs):
                self.assertEqual(path, root)
                return real_resolve(path, *args, **kwargs)
            # The root is canonical already. No readlink outside its ancestor
            # chain, and no stat/open with a multi-component child is allowed.
            real_stat=os.stat;real_open=os.open;real_readlink=os.readlink
            def anchored_stat(path, *args, **kwargs):
                if 'dir_fd' not in kwargs:
                    self.assertEqual(pathlib.Path(path),root)
                    return real_stat(path,*args,**kwargs)
                self.assertIn(str(path), ('internal','external','dangling','chain','equal'))
                self.assertIs(kwargs.get('follow_symlinks'), False)
                self.assertIsInstance(kwargs.get('dir_fd'), int)
                return real_stat(path, *args, **kwargs)
            def root_open_only(path, flags, *args, **kwargs):
                self.assertEqual(path, root)
                return real_open(path, flags, *args, **kwargs)
            def trusted_readlink_only(path, *args, **kwargs):
                self.assertIn(pathlib.Path(path), (root, *root.parents))
                return real_readlink(path, *args, **kwargs)
            with patch.object(pathlib.Path,'resolve',resolve_trusted_only), \
                 patch.object(os,'stat',anchored_stat), patch.object(os,'open',root_open_only), \
                 patch.object(os,'readlink',trusted_readlink_only):
                for name in ('internal','external','dangling','chain','equal'):
                    for suffix in ('', '/script.py'):
                        with self.subTest(selector=name+suffix), self.assertRaisesRegex(ValueError,'Symlinks'):
                            m.confined_path(root,name+suffix)
    def test_selector_ordinary_nested_and_missing_descendants_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'task').mkdir()
            (root/'task'/'check.py').write_text('pass')
            for selector in ('task','task/check.py','task/missing/deeper.py','new/deeper.py'):
                with self.subTest(selector=selector):
                    self.assertEqual(m.confined_path(root,selector),root.resolve()/selector)
    def test_nested_symlink_component_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'task').mkdir()
            (root/'task'/'link').symlink_to(root)
            for selector in ('task/link','task/link/check.py'):
                with self.subTest(selector=selector),self.assertRaisesRegex(ValueError,'Symlinks'):
                    m.confined_path(root,selector)
    def test_trusted_root_alias_is_canonicalized(self):
        with tempfile.TemporaryDirectory() as directory:
            base=pathlib.Path(directory);root=base/'root';root.mkdir()
            alias=base/'trusted-alias';alias.symlink_to(root)
            self.assertEqual(m.confined_path(alias,'missing/check.py'),root.resolve()/'missing/check.py')
    def test_selector_lexical_rejection_precedes_any_filesystem_lookup(self):
        for selector in ('../outside','task/../outside','/outside','','.'):
            with self.subTest(selector=selector), patch.object(pathlib.Path,'resolve') as resolve, \
                 patch.object(os,'open') as opened, patch.object(os,'stat') as stated:
                with self.assertRaises(ValueError):m.confined_path('/trusted',selector)
                resolve.assert_not_called();opened.assert_not_called();stated.assert_not_called()
    def test_component_swap_to_link_is_not_followed_and_descriptors_close(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'task').mkdir()
            outside=root/'outside';outside.mkdir()
            real_stat=os.stat;real_open=os.open;real_close=os.close;opened=[];closed=[]
            def swapping_stat(path, *args, **kwargs):
                result=real_stat(path,*args,**kwargs)
                if path=='task':
                    (root/'task').rename(root/'original-task')
                    (root/'task').symlink_to(outside)
                return result
            def track_open(*args, **kwargs):
                fd=real_open(*args,**kwargs);opened.append(fd);return fd
            def track_close(fd):closed.append(fd);return real_close(fd)
            with patch.object(os,'stat',swapping_stat),patch.object(os,'open',track_open),patch.object(os,'close',track_close):
                with self.assertRaises(OSError):m.confined_path(root,'task/check.py')
            self.assertEqual(opened,closed)
    def test_main_refuses_escaped_fixture_script_before_copy_or_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);core=root/'core';(core/'.git').mkdir(parents=True)
            (core/'.git/HEAD').write_text('a'*40)
            scripts=root/'bench/tasks';scripts.mkdir(parents=True)
            (scripts/'escape').symlink_to(root)
            real_confined=m.confined_path;real_read=pathlib.Path.read_text
            for field in ('setup_script','check_script'):
                task={'id':'task','setup_script':'setup.py','check_script':'check.py',field:'escape/outside.py'}
                def remap_confined(path, selector):
                    return real_confined(root/pathlib.Path(path).relative_to('/work'),selector)
                def manifest_read(path,*args,**kwargs):
                    if str(path)=='/work/bench/tasks/manifest.json':return json.dumps([task])
                    return real_read(path,*args,**kwargs)
                with self.subTest(field=field),patch.object(sys,'argv',['replay','--core','core','--label','test','--tasks','task','--modes','cold']), \
                     patch.object(m,'confined_path',remap_confined),patch.object(pathlib.Path,'read_text',manifest_read), \
                     patch.object(m.http.server,'ThreadingHTTPServer'),patch.object(m.threading,'Thread'), \
                     patch.object(m.shutil,'copytree') as copy,patch.object(m,'command') as command:
                    with self.assertRaisesRegex(ValueError,'Symlinks'):m.main()
                    copy.assert_not_called();command.assert_not_called()
    def test_command_rejects_interpreter_flags_and_unapproved_executables(self):
        for args in (['sh','/tmp/script'], ['python3','-c','print(1)'], ['node','--eval','x'], 'node /tmp/script'):
            with self.subTest(args=args), patch.object(m.subprocess,'run') as run:
                with self.assertRaises(ValueError):m.command(args)
                run.assert_not_called()
    def test_command_keeps_script_arguments_literal_without_a_shell(self):
        with patch.object(m.subprocess,'run') as run:
            run.return_value.returncode=0
            args=['node','/work/core/runtime/bin/agenc','literal; $(not-executed)']
            self.assertEqual(m.command(args),0)
            self.assertEqual(run.call_args.args[0],[args[0],'--',*args[1:]])
            self.assertIs(run.call_args.kwargs['shell'],False)
    def test_prompt_starting_with_an_option_is_stdin_data(self):
        with patch.object(m.subprocess,'run') as run:
            run.return_value.returncode=0
            args=['node','/work/core/runtime/bin/agenc','-p']
            prompt='--some-option\nLiteral prompt with $() and quotes'
            self.assertEqual(m.command(args,stdin_text=prompt),0)
            self.assertEqual(run.call_args.args[0],[args[0],'--',*args[1:]])
            self.assertEqual(run.call_args.kwargs['input'],prompt)
            self.assertTrue(run.call_args.kwargs['text'])
    def test_real_interpreters_keep_option_shaped_script_arguments_literal(self):
        sources = {'python3': 'import json,sys; print(json.dumps(sys.argv[1:]))',
                   'node': 'console.log(JSON.stringify(process.argv.slice(2)))'}
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            arguments=['--eval','literal; $(not-executed)','-c']
            for interpreter, source in sources.items():
                with self.subTest(interpreter=interpreter):
                    script=root/('-script.py' if interpreter=='python3' else '-script.cjs')
                    script.write_text(source)
                    log=root/(interpreter+'.log')
                    self.assertEqual(m.command([interpreter,str(script),*arguments],log=log),0)
                    self.assertEqual(json.loads(log.read_text()),arguments)
    def test_a_poll_uses_the_handle_returned_by_the_matching_live_tool(self):
        reply={'tool_calls':[{'id':'poll','function':{'name':'write_stdin','arguments':'{"session_id":16,"chars":""}'}}]}
        body={'messages':[{'role':'tool','tool_call_id':'other','content':'session_id=99'},
                          {'role':'tool','tool_call_id':'exec','content':'[exec yielded=true session_id=23]'}]}
        mapped=m.map_poll_sessions(body,reply,{'exec':16},{})
        self.assertEqual(json.loads(mapped['tool_calls'][0]['function']['arguments'])['session_id'],23)
        self.assertEqual(json.loads(reply['tool_calls'][0]['function']['arguments'])['session_id'],16)
    def test_unmatched_handles_fail_instead_of_polling_an_unrelated_process(self):
        reply={'tool_calls':[{'id':'poll','function':{'name':'write_stdin','arguments':'{"session_id":16}'}}]}
        with self.assertRaises(RuntimeError):m.map_poll_sessions({'messages':[]},reply,{'exec':16},{})
    def test_only_recorded_polled_commands_get_an_early_yield(self):
        replies=[{'tool_calls':[{'id':name,'function':{'name':'exec_command','arguments':'{"cmd":"python3 -m unittest","yield_time_ms":10000}'}} for name in ('exec','other')]}]
        self.assertEqual(m.prepare_polled_commands(replies,{'exec':16}),['exec'])
        self.assertEqual([json.loads(c['function']['arguments'])['yield_time_ms'] for c in replies[0]['tool_calls']],[1,10000])
if __name__=='__main__':unittest.main()
