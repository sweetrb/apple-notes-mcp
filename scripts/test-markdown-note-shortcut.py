"""Check the Markdown bridge's serialized execution boundaries before signing/importing."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).with_name('build-markdown-note-shortcut.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class MarkdownBridgeTests(unittest.TestCase):
    def test_create_note_interprets_markdown_in_the_background(self):
        creates = [a['WFWorkflowActionParameters'] for a in bridge.build()['WFWorkflowActions']
                   if a['WFWorkflowActionIdentifier'] == 'com.apple.mobilenotes.SharingExtension']
        self.assertEqual(len(creates), 1)
        p = creates[0]
        self.assertEqual(p['AppIntentDescriptor']['AppIntentIdentifier'], 'CreateNoteLinkAction')
        self.assertIs(p['interpretAsMarkdown'], True)
        self.assertIs(p['OpenWhenRun'], False)
        self.assertEqual(p['WFCreateNoteInput']['WFSerializationType'], 'WFTextTokenString')
        self.assertEqual(p['WFCreateNoteInput']['Value']['attachmentsByRange']['{0, 1}']['Type'], 'ActionOutput')
        self.assertEqual(p['folder']['identifier'], 'applenotes:folder/DefaultFolder-CloudKit')

    def test_creation_is_reachable_only_for_the_named_operation(self):
        actions = bridge.build()['WFWorkflowActions']
        names = [a['WFWorkflowActionIdentifier'] for a in actions]
        start = names.index('com.apple.mobilenotes.SharingExtension')
        opener = actions[start - 1]['WFWorkflowActionParameters']
        self.assertEqual(actions[start - 1]['WFWorkflowActionIdentifier'], 'is.workflow.actions.conditional')
        self.assertEqual(opener['WFControlFlowMode'], 0)
        self.assertEqual(opener['WFConditionalActionString'], 'create-markdown')

    def test_conditions_use_text_producers(self):
        actions = bridge.build()['WFWorkflowActions']
        producers = {a['WFWorkflowActionParameters']['UUID']: a['WFWorkflowActionIdentifier'] for a in actions}
        for action in actions:
            p = action['WFWorkflowActionParameters']
            if action['WFWorkflowActionIdentifier'] == 'is.workflow.actions.conditional' and p['WFControlFlowMode'] == 0:
                source = p['WFInput']['Variable']['Value']['OutputUUID']
                self.assertEqual(producers[source], 'is.workflow.actions.gettext')

    def test_no_ui_or_arbitrary_execution_actions(self):
        allowed = {'is.workflow.actions.' + x for x in
                   ['comment', 'detect.dictionary', 'getvalueforkey', 'gettext', 'conditional', 'output']}
        allowed.add('com.apple.mobilenotes.SharingExtension')
        for action in bridge.build()['WFWorkflowActions']:
            self.assertIn(action['WFWorkflowActionIdentifier'], allowed)

if __name__ == '__main__':
    unittest.main()
