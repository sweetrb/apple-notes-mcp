#!/usr/bin/env python3
"""Build the reviewed create-from-Markdown Notes bridge; signing is a separate step."""
import importlib.util
import plistlib
from pathlib import Path
from uuid import uuid5, NAMESPACE_URL
spec = importlib.util.spec_from_file_location('tags', Path(__file__).with_name('build-native-tags-shortcut.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
action, output, token, text_token = b.action, b.output, b.token, b.text_token
NAME = 'Apple Notes MCP - Create Markdown Note'
# The iCloud account's default "Notes" folder. Notes only interprets Markdown in iCloud accounts.
DEFAULT_FOLDER = 'applenotes:folder/DefaultFolder-CloudKit'

def uid(label):
    return str(uuid5(NAMESPACE_URL, 'apple-notes-mcp/markdown-note/v1/' + label)).upper()

b.uid = uid

def condition(label, source, value):
    return action('is.workflow.actions.conditional', label, GroupingIdentifier=uid(label+'-group'), WFControlFlowMode=0,
                  WFInput={'Type':'Variable','Variable':source}, WFCondition=4, WFConditionalActionString=value)

def end(label):
    return action('is.workflow.actions.conditional', label+'-end', GroupingIdentifier=uid(label+'-group'), WFControlFlowMode=2)

def create_note(label, source):
    # Native editor serialization of Notes' Create Note intent on macOS 26+,
    # with "Interpret as Markdown" enabled and the note left closed.
    return action('com.apple.mobilenotes.SharingExtension', label,
                  WFCreateNoteInput=text_token(output(source)), interpretAsMarkdown=True, OpenWhenRun=False,
                  WFNoteGroup={'DisplayString':'Notes','Identifier':DEFAULT_FOLDER},
                  folder={'identifier':DEFAULT_FOLDER,'subtitle':{'key':'Notes'},
                          'symbol':{'systemName':'folder'},'title':{'key':'Notes'}},
                  AppIntentDescriptor={'AppIntentIdentifier':'CreateNoteLinkAction',
                                       'BundleIdentifier':'com.apple.Notes',
                                       'TeamIdentifier':'0000000000','Name':'Notes'})

def build():
    a=[action('is.workflow.actions.comment','markdown-about',WFCommentActionText='Creates one note from Markdown with Notes\' own importer, in the iCloud default folder. Input: JSON {operation: create-markdown, text}. No search, edits, deletion, shell scripts, network or arbitrary action execution. The MCP finds the new note among notes added to the default folder and verifies it by exact-ID readback.'),
       action('is.workflow.actions.detect.dictionary','request',WFInput=token({'Type':'ExtensionInput'}))]
    for k in ['operation','text']:
        a.append(action('is.workflow.actions.getvalueforkey',k+'-value',WFInput=output('request'),WFDictionaryKey=k,WFGetDictionaryValueType='Value'))
        # Dictionary Value is an untyped Content Item; conditions and Notes need text.
        a.append(action('is.workflow.actions.gettext',k,WFTextActionText=text_token(output(k+'-value'))))
    a.append(condition('op-create-markdown',output('operation'),'create-markdown'))
    a.append(create_note('created','text'))
    a.append(action('is.workflow.actions.gettext','op-create-markdown-ok',WFTextActionText='APPLE_NOTES_MARKDOWN_V1_DONE'))
    a.append(action('is.workflow.actions.output','op-create-markdown-output',WFOutput=text_token(output('op-create-markdown-ok'))))
    a.append(end('op-create-markdown'))
    a += [action('is.workflow.actions.gettext','refused',WFTextActionText='APPLE_NOTES_MARKDOWN_V1_REFUSED'),action('is.workflow.actions.output','refused-output',WFOutput=text_token(output('refused')))]
    w=b.build();w.update(WFWorkflowName=NAME,WFWorkflowActions=a)
    return w

if __name__=='__main__':
    path=Path(__file__).resolve().parents[1]/'shortcuts'/(NAME+'.unsigned.shortcut')
    path.write_bytes(plistlib.dumps(build(),fmt=plistlib.FMT_XML,sort_keys=False)); print(path)
