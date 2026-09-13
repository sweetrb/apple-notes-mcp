#!/usr/bin/env python3
"""Build an unsigned, reviewable Apple Shortcuts bridge; signing is a separate step."""
import plistlib
from pathlib import Path
from uuid import uuid5, NAMESPACE_URL

ROOT = Path(__file__).resolve().parents[1]
NAME = "Apple Notes MCP - Native Tags"


def uid(label):
    return str(uuid5(NAMESPACE_URL, "apple-notes-mcp/native-tags/v1/" + label)).upper()


def token(value):
    return {"Value": value, "WFSerializationType": "WFTextTokenAttachment"}


def output(label):
    return token({"Type": "ActionOutput", "OutputUUID": uid(label), "OutputName": label})


def text_token(value):
    return {"WFSerializationType": "WFTextTokenString", "Value": {
        "string": "\ufffc", "attachmentsByRange": {"{0, 1}": value["Value"]}}}


def action(identifier, label, **params):
    return {"WFWorkflowActionIdentifier": identifier,
            "WFWorkflowActionParameters": {"UUID": uid(label), **params}}


def native(identifier, label, **params):
    return action("com.apple.Notes." + identifier, label,
                  AppIntentDescriptor={"AppIntentIdentifier": identifier,
                                       "BundleIdentifier": "com.apple.Notes",
                                       "TeamIdentifier": "0000000000", "Name": "Notes"},
                  ShowWhenRun=False, **params)


def build():
    actions = [action("is.workflow.actions.comment", "about",
                      WFCommentActionText="Adds native tags to one note selected by title and existing project scope text. Refuses zero/multiple results. Input: JSON {title, scopeText, tags}. No scripts, network, deletion or body replacement. The MCP checks exact ID/revision before and verifies native tags/text/links afterward.")]
    actions.append(action("is.workflow.actions.detect.dictionary", "request",
                          WFInput=token({"Type": "ExtensionInput"})))
    for key in ["title", "scopeText", "tags"]:
        actions.append(action("is.workflow.actions.getvalueforkey", key,
                              WFInput=output("request"), WFDictionaryKey=key,
                              WFGetDictionaryValueType="Value"))
    actions.append(action("is.workflow.actions.filter.notes", "target",
                          WFContentItemLimitEnabled=False,
                          WFContentItemFilter={"WFSerializationType": "WFContentPredicateTableTemplate", "Value": {
                              "WFActionParameterFilterPrefix": 1,
                              "WFContentPredicateBoundedDate": False,
                              "WFActionParameterFilterTemplates": [
                                  {"Property": prop, "Operator": 99, "Removable": True,
                                   "Values": {"String": text_token(output(key))}}
                                  for prop, key in [("Name", "title"), ("Body", "scopeText")]
                              ]
                          }}))
    actions.append(action("is.workflow.actions.count", "count", Input=output("target"), WFCountType="Items"))
    actions.append(action("is.workflow.actions.gettext", "count-text", WFTextActionText=text_token(output("count"))))
    group = uid("unique-condition")
    actions.append(action("is.workflow.actions.conditional", "unique", GroupingIdentifier=group,
                          WFControlFlowMode=0, WFInput={"Type": "Variable", "Variable": output("count-text")},
                          WFCondition=4, WFConditionalActionString="1"))
    repeat = uid("tag-repeat")
    actions.append(action("is.workflow.actions.repeat.each", "repeat-start", GroupingIdentifier=repeat,
                          WFControlFlowMode=0, WFInput=output("tags")))
    actions.append(native("CreateTagLinkAction", "native-tag",
                          name=text_token(token({"Type": "Variable", "VariableName": "Repeat Item"}))))
    actions.append(native("AddTagsToNotesLinkAction", "tagged-note", notes=output("target"), tags=output("native-tag")))
    actions.append(action("is.workflow.actions.repeat.each", "repeat-end", GroupingIdentifier=repeat, WFControlFlowMode=2))
    actions.append(action("is.workflow.actions.gettext", "success", WFTextActionText="APPLE_NOTES_TAGS_OK"))
    actions.append(action("is.workflow.actions.output", "return-success", WFOutput=output("success")))
    actions.append(action("is.workflow.actions.conditional", "otherwise", GroupingIdentifier=group, WFControlFlowMode=1))
    actions.append(action("is.workflow.actions.gettext", "refusal", WFTextActionText="APPLE_NOTES_TAGS_AMBIGUOUS_OR_MISSING"))
    actions.append(action("is.workflow.actions.output", "return-refusal", WFOutput=output("refusal")))
    actions.append(action("is.workflow.actions.conditional", "end", GroupingIdentifier=group, WFControlFlowMode=2))
    return {"WFWorkflowName": NAME, "WFWorkflowActions": actions,
            "WFWorkflowClientVersion": "2600", "WFWorkflowMinimumClientVersion": 900,
            "WFWorkflowMinimumClientVersionString": "900", "WFWorkflowTypes": [],
            "WFWorkflowHasShortcutInputVariables": True,
            "WFWorkflowHasOutputAction": True,
            "WFWorkflowInputContentItemClasses": ["WFStringContentItem", "WFDictionaryContentItem", "WFGenericFileContentItem"],
            "WFWorkflowOutputContentItemClasses": ["WFStringContentItem"],
            "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4251333119, "WFWorkflowIconGlyphNumber": 59507},
            "WFWorkflowImportQuestions": []}


if __name__ == "__main__":
    destination = ROOT / "shortcuts" / (NAME + ".unsigned.shortcut")
    destination.parent.mkdir(exist_ok=True)
    destination.write_bytes(plistlib.dumps(build(), fmt=plistlib.FMT_XML, sort_keys=False))
    print(destination)
