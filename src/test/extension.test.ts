import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('MLLANN01.azure-devops-backlog-explorer'));
	});

	test('Should register commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('azureDevOpsBacklog.helloWorld'));
	});
});
