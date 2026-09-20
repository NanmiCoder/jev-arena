import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from accuracy_score import categorical,multilabel,evaluate
from accuracy_audit import validate

class AccuracyScoringTests(unittest.TestCase):
    def test_ambiguity_and_unjudgeable_are_not_clear_errors(self):
        x=categorical([['a'],['b','a'],[],['b']],['a','a','a','a'],['a','b'])
        self.assertEqual(x['strict_correct'],1)
        self.assertEqual(x['accepted_correct'],2)
        self.assertEqual(x['strict_accuracy_all'],.25)
        self.assertEqual(x['accepted_accuracy_decidable'],2/3)
        self.assertEqual(x['clear_wrong'],1)
        self.assertEqual(x['ambiguous_hit'],1)
        self.assertEqual(x['unjudgeable'],1)
        self.assertEqual(sum(sum(v.values()) for v in x['confusion_primary_reference'].values()),3)
    def test_multilabel_empty_sets_do_not_invent_true_positives(self):
        x=multilabel([[],['a','b'],['a']],[[],['a','c'],[]])
        self.assertEqual((x['tp'],x['fp'],x['fn']),(1,1,2))
        self.assertEqual(x['micro_f1'],.4)
        self.assertAlmostEqual(x['mean_jaccard'],4/9)
        self.assertEqual(x['exact_correct'],1)
    def test_join_requires_exact_unique_ids(self):
        item={'id':'0001','r':[True],'s':['neutral'],'i':['question'],'a':[],'e':[],'score':0,'reason':'询问'}
        self.assertEqual(validate({'items':[item]},['0001']),[item])
        with self.assertRaises(AssertionError):validate({'items':[item]},['1'])
        with self.assertRaises(AssertionError):validate({'items':[item,item]},['0001','0002'])
    def test_core_requires_all_three_fields(self):
        rows=[{'comment_id':'001'},{'comment_id':'002'}]
        r={'001':{'r':[True],'s':['neutral'],'i':['question'],'a':[],'e':[],'score':0},'002':{'r':[False],'s':['positive'],'i':['joke','praise'],'a':[],'e':[],'score':.5}}
        p={'001':{'is_relevant':True,'sentiment':'neutral','intent':'question','aspects':[],'emotion':[],'sentiment_score':0},'002':{'is_relevant':False,'sentiment':'positive','intent':'praise','aspects':[],'emotion':[],'sentiment_score':.7}}
        x=evaluate(rows,r,p)
        self.assertEqual(x['core']['strict_correct'],1)
        self.assertEqual(x['core']['accepted_correct'],2)
        self.assertAlmostEqual(x['score']['mae'],.1)

if __name__=='__main__':unittest.main()
