"""Check the bridge's serialized execution boundaries before signing/importing."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).with_name('build-native-operations-shortcut.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class BridgeTests(unittest.TestCase):
    def test_legacy_append_and_native_create_configuration(self):
        for action in bridge.build()['WFWorkflowActions']:
            name = action['WFWorkflowActionIdentifier']
            p = action['WFWorkflowActionParameters']
            if name == 'is.workflow.actions.appendnote':
                self.assertIn('WFNote', p)
                self.assertIn('WFInput', p)
                self.assertEqual(p['WFInput']['WFSerializationType'], 'WFTextTokenString')
                self.assertEqual(p['WFInput']['Value']['string'], '\ufffc')
                self.assertEqual(p['WFInput']['Value']['attachmentsByRange']['{0, 1}']['Type'], 'ActionOutput')
                self.assertEqual(p['AppIntentDescriptor']['AppIntentIdentifier'], 'AppendToNoteLinkAction')
                self.assertNotIn('text', p)
                self.assertNotIn('entity', p)
            if name in ['com.apple.Notes.CreateChecklistItemLinkAction', 'com.apple.Notes.CreateTagLinkAction']:
                self.assertFalse(p['OpenWhenRun'])
            if name == 'com.apple.Notes.PinNotesLinkAction':
                self.assertIn(p['operation'], ['add', 'remove'])

    def test_native_text_parameters_are_text_tokens(self):
        for action in bridge.build()['WFWorkflowActions']:
            name = action['WFWorkflowActionIdentifier']
            p = action['WFWorkflowActionParameters']
            if name.startswith('com.apple.Notes.'):
                for key in ['name', 'text']:
                    if key in p:
                        self.assertEqual(p[key]['WFSerializationType'], 'WFTextTokenString')
            if name == 'is.workflow.actions.getrichtextfromhtml':
                self.assertIn('WFHTML', p)
                self.assertNotIn('WFInput', p)

    def test_conditions_use_text_producers(self):
        actions = bridge.build()['WFWorkflowActions']
        producers = {a['WFWorkflowActionParameters']['UUID']: a['WFWorkflowActionIdentifier'] for a in actions}
        for action in actions:
            p = action['WFWorkflowActionParameters']
            if action['WFWorkflowActionIdentifier'] == 'is.workflow.actions.conditional' and p['WFControlFlowMode'] == 0:
                source = p['WFInput']['Variable']['Value']['OutputUUID']
                self.assertEqual(producers[source], 'is.workflow.actions.gettext')

    def test_no_ui_or_arbitrary_execution_actions(self):
        allowed = {'comment', 'detect.dictionary', 'getvalueforkey', 'gettext', 'filter.notes',
                   'count', 'conditional', 'getrichtextfrommarkdown', 'getrichtextfromhtml', 'output', 'appendnote'}
        native = {'AppendToNoteLinkAction', 'CreateChecklistItemLinkAction', 'PinNotesLinkAction',
                  'CreateTagLinkAction', 'AddTagsToNotesLinkAction', 'RemoveTagsFromNotesLinkAction'}
        for action in bridge.build()['WFWorkflowActions']:
            name = action['WFWorkflowActionIdentifier']
            self.assertTrue(name in {'is.workflow.actions.'+x for x in allowed} |
                            {'com.apple.Notes.'+x for x in native}, name)
            if name.startswith('com.apple.Notes.'):
                self.assertFalse(action['WFWorkflowActionParameters']['ShowWhenRun'])

if __name__ == '__main__':
    unittest.main()
