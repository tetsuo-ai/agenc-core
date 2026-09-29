import importlib.util
import pathlib
import unittest
spec=importlib.util.spec_from_file_location('summarize',pathlib.Path(__file__).with_name('summarize.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class IntervalTests(unittest.TestCase):
    def test_parallel_tools_are_not_double_counted(self):
        self.assertEqual(module.union_ms([(10,30),(20,40),(45,50)]),35)
    def test_post_tool_partition_does_not_double_count_nested_durability(self):
        spans=[{'name':'admission.model','start_ms':0,'duration_ms':10},
               {'name':'persistence.fsync','start_ms':2,'duration_ms':3}]
        self.assertEqual(module.post_tool_attribution([(0,12)],spans),{'admission':7,'fsync':3,'other':2})
    def test_no_tools_and_adjacent_tools(self):
        self.assertEqual(module.union_ms([]),0)
        self.assertEqual(module.union_ms([(20,30),(10,20)]),20)
if __name__=='__main__':unittest.main()
