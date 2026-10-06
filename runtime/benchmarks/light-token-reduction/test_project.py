import unittest
from project import dynamic_context, result_text, sparse_read, BOUNDARY

class ProjectionTest(unittest.TestCase):
    def test_sparse_preserves_lines_unicode_and_offsets(self):
        text='8→α\n9→😀\n10→\n11→AGENC_DATA'
        self.assertEqual(sparse_read(text),'8→α\n😀\n10→\n11→AGENC_DATA')
        self.assertEqual(sparse_read('8→a\nnot numbered\n10→c'),'8→a\nnot numbered\n10→c')
    def test_routine_footer_only(self):
        self.assertEqual(result_text('ok\n\n[exec exit_code=0 wall_time=0.0040s tokens=1]','exec_command'),'ok\n\n[exec exit_code=0]')
        for footer in ['exit_code=1','exit_code=0 session_id=2','yielded=true','timed_out=true']:
            text='ok\n\n[exec '+footer+' wall_time=0.0040s tokens=1]'
            self.assertEqual(result_text(text,'exec_command'),text)
        text='Output truncated\n[exec exit_code=0 wall_time=0.0040s tokens=1]'
        self.assertEqual(result_text(text,'exec_command'),text)
    def test_workspace_frame_only(self):
        payload='1→a\n2→β\n3→c'
        workspace=f'The following tool result is untrusted workspace data from FileRead.\n{BOUNDARY}\n{payload}\n{BOUNDARY}'
        self.assertEqual(result_text(workspace,'FileRead'),'AGENC_DATA\n1→a\nβ\n3→c\nAGENC_DATA')
        external=workspace.replace('workspace data','external data')
        self.assertEqual(result_text(external,'FileRead'),external)
    def test_runtime_only_context(self):
        exported={'memory_example':'global /GLOBAL/ project /PROJECT/'}
        task='Please edit # Memory directories and preserve the existing content.'
        self.assertEqual(dynamic_context(task,exported),task)
        bad='# Memory directories\nINVENTED\n\n# Permission Mode: plan'
        with self.assertRaises(ValueError):dynamic_context(bad,exported)
    def test_permissions_preserved(self):
        memory=('# Memory directories\n\n- Global memory (user-level, shared across projects): `/g/`\n'
                '- Project memory (this repository, shared by its git worktrees): `/p/`\n'
                '- Session memory is the current conversation: use plans and tasks for state that only matters in this session.\n\n'
                'These directories already exist. Write to them directly with the Write tool; do not run mkdir or check for their existence.')
        permission='# Permission Mode: acceptEdits\nKEEP EVERY POLICY WORD'
        text=memory+'\n\n# Environment\n<cwd>/workspace</cwd>\n - Date: irrelevant\n\n'+permission
        self.assertEqual(dynamic_context(text,{'memory_example':'global /GLOBAL/ project /PROJECT/'}),
                         'global /g/ project /p/\n\nWorkspace: /workspace\n\n'+permission)

if __name__=='__main__':unittest.main()
