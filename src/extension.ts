import * as vscode from 'vscode';
// 后续接入真实 CLI 时，需要打开下面这行 import：
// import { exec } from 'child_process';
// import { promisify } from 'util';
// const execAsync = promisify(exec);

/**
 * SVF 解析后得到的单条问题结构。
 * - line / column 使用「人类可读」的 1-based 行列号（与 SVF 原始输出保持一致）
 * - 在转换成 vscode.Diagnostic 时，会统一减 1，转换为 VS Code 的 0-based 坐标
 */
interface SVFIssue {
    line: number;      // 1-based，来自 SVF 输出
    column: number;    // 1-based，来自 SVF 输出
    message: string;   // 错误描述
    severity: vscode.DiagnosticSeverity;
}

/**
 * 全局唯一的 DiagnosticCollection。
 * 一个 collection 内同一个 uri 的诊断会被整体替换，避免重复堆积。
 */
let diagnosticCollection: vscode.DiagnosticCollection;

/**
 * 插件激活入口：VS Code 在第一次触发命令时会调用本函数。
 */
export function activate(context: vscode.ExtensionContext) {
    // 1. 创建一个名为 "svf" 的诊断集合，名字会显示在 Problems 面板的来源列
    diagnosticCollection = vscode.languages.createDiagnosticCollection('svf');
    context.subscriptions.push(diagnosticCollection);

    // 2. 注册命令：svf.runAnalysis —— 对当前活动编辑器执行 SVF 分析
    const runDisposable = vscode.commands.registerCommand('svf.runAnalysis', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('SVF: 当前没有打开的编辑器，无法执行分析。');
            return;
        }

        const document = editor.document;

        try {
            // ============================================================
            // 【MOCK 数据 - 后续替换点】
            // 当前直接使用一段写死的字符串模拟 SVF CLI 的 stdout 输出。
            //
            // 接入真实 CLI 时，把下面这段 mock 替换为类似：
            //
            //   const filePath = document.fileName;
            //   const { stdout } = await execAsync(`svf-analyzer "${filePath}"`);
            //   const rawOutput = stdout;
            //
            // 注意点：
            //   - 用 execAsync 时记得 try/catch 处理非 0 返回码
            //   - 工作目录可通过 { cwd: vscode.workspace.rootPath } 指定
            //   - 大文件分析耗时较长，建议套一层 vscode.window.withProgress
            // ============================================================
            const rawOutput = [
                'Memory Leak detected at line 10, column 5',
                'Tainted Flow source at line 15, column 8',
                'Null Pointer Dereference at line 3, column 12'
            ].join('\n');

            const issues = parseSVFOutput(rawOutput);
            applyDiagnostics(document, issues);

            vscode.window.showInformationMessage(
                `SVF: 分析完成，共发现 ${issues.length} 个问题。`
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`SVF: 分析失败 - ${msg}`);
        }
    });

    // 3. 注册命令：svf.clearDiagnostics —— 清空所有诊断
    const clearDisposable = vscode.commands.registerCommand('svf.clearDiagnostics', () => {
        diagnosticCollection.clear();
        vscode.window.showInformationMessage('SVF: 已清除所有诊断信息。');
    });

    context.subscriptions.push(runDisposable, clearDisposable);

    // 4. 注册侧边栏 Tree View（污点流传播路径）
    registerSvfTreeView(context);
}

/**
 * 解析 SVF 文本输出。
 * 期望格式示例：
 *   "Memory Leak detected at line 10, column 5"
 *   "Tainted Flow source at line 15, column 8"
 *
 * 正则说明：
 *   ^(.*?)            -> 非贪婪匹配描述信息（错误消息）
 *   \s+at\s+line\s+   -> 固定分隔串
 *   (\d+)             -> 行号（1-based）
 *   ,\s*column\s+     -> 列分隔
 *   (\d+)             -> 列号（1-based）
 *
 * 返回的 SVFIssue 仍然保留 1-based，转换成 0-based 的工作放在 applyDiagnostics 里完成，
 * 这样解析器的输出可以独立被单元测试。
 */
export function parseSVFOutput(rawOutput: string): SVFIssue[] {
    const issues: SVFIssue[] = [];
    const regex = /^(.*?)\s+at\s+line\s+(\d+)\s*,\s*column\s+(\d+)\s*$/i;

    const lines = rawOutput.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const match = regex.exec(trimmed);
        if (!match) {
            // 无法识别的行直接跳过；如需排错可在此处 console.warn
            continue;
        }

        const [, message, lineStr, columnStr] = match;
        issues.push({
            message: message.trim(),
            line: parseInt(lineStr, 10),
            column: parseInt(columnStr, 10),
            severity: vscode.DiagnosticSeverity.Error
        });
    }

    return issues;
}

/**
 * 把解析后的 SVFIssue 列表转换为 vscode.Diagnostic 并写入诊断集合。
 * 这里集中处理「1-based -> 0-based」、「越界保护」、「高亮范围」等细节。
 */
function applyDiagnostics(document: vscode.TextDocument, issues: SVFIssue[]): void {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const issue of issues) {
        // VS Code 行列号是 0-based，所以这里统一 -1
        // 同时做下界保护，防止 SVF 给出 0 或负数时构造出非法 Position
        const zeroLine = Math.max(0, issue.line - 1);
        const zeroCol = Math.max(0, issue.column - 1);

        // 防止行号超出文档实际行数
        const safeLine = Math.min(zeroLine, Math.max(0, document.lineCount - 1));
        const lineText = document.lineAt(safeLine).text;

        // 范围策略：
        //   1. 优先尝试高亮 (column, column + 5) 这一段（共 5 个字符）
        //   2. 如果 column 已经超过该行长度，则退化为「整行高亮」
        let range: vscode.Range;
        if (zeroCol < lineText.length) {
            const endCol = Math.min(lineText.length, zeroCol + 5);
            range = new vscode.Range(safeLine, zeroCol, safeLine, endCol);
        } else {
            // 整行高亮：从 0 列到该行末尾
            range = new vscode.Range(safeLine, 0, safeLine, Math.max(1, lineText.length));
        }

        const diagnostic = new vscode.Diagnostic(range, issue.message, issue.severity);
        diagnostic.source = 'SVF';   // 显示在 Problems 面板的 source 列
        diagnostic.code = 'svf-analysis';
        diagnostics.push(diagnostic);
    }

    // 用当前文档的 uri 作为 key，整体替换该文件之前的诊断
    diagnosticCollection.set(document.uri, diagnostics);
}

/**
 * 插件停用：清空诊断并释放资源。
 */
export function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.clear();
        diagnosticCollection.dispose();
    }
}

/* ================================================================
 * 【package.json 必要的 contributes 配置（已写好在同目录的 package.json）】
 *
 * "contributes": {
 *   "commands": [
 *     {
 *       "command": "svf.runAnalysis",
 *       "title": "SVF: Run Analysis on Current File",
 *       "category": "SVF"
 *     },
 *     {
 *       "command": "svf.clearDiagnostics",
 *       "title": "SVF: Clear Diagnostics",
 *       "category": "SVF"
 *     }
 *   ]
 * }
 *
 * 同时建议在 package.json 顶层加上：
 *
 * "activationEvents": [
 *   "onCommand:svf.runAnalysis",
 *   "onCommand:svf.clearDiagnostics"
 * ]
 * ================================================================ */


// ====================================================================
// ============  侧边栏 Tree View：污点流传播路径展示  =================
// ====================================================================

/**
 * 子节点类型：标识这条传播路径上某一步的角色
 *  - source       : 污点来源
 *  - propagation  : 中间传播节点
 *  - sink         : 污点最终汇入点（危险操作）
 */
type FlowStepKind = 'source' | 'propagation' | 'sink';

/**
 * 污点流传播路径上的一步（子节点的数据模型）
 */
interface FlowStep {
    kind: FlowStepKind;
    line: number;        // 1-based 行号（与 SVF 输出习惯一致）
    description: string; // 简要描述，例如 "user input from argv"
    file?: string;       // 可选：跨文件污点流时指定具体文件路径
}

/**
 * 一条完整的污点流（父节点的数据模型）
 */
interface TaintFlow {
    id: string;
    label: string;       // 父节点显示文本
    steps: FlowStep[];   // 传播路径
}

/**
 * Tree 节点统一抽象：父节点用 TaintFlow，子节点用 FlowStep。
 * 通过 `type` 字段区分，方便 getTreeItem 时分别处理样式。
 */
type SvfTreeNode =
    | { type: 'flow'; flow: TaintFlow }
    | { type: 'step'; step: FlowStep; parent: TaintFlow };

/**
 * TreeDataProvider 实现。
 * VS Code 会通过 getChildren / getTreeItem 两个方法异步拉取数据并渲染。
 */
export class SvfFlowTreeProvider implements vscode.TreeDataProvider<SvfTreeNode> {
    /**
     * 用于通知 VS Code 数据已经发生变化、需要重新渲染。
     * 后续接入真实 SVF 数据后，调用 `this.refresh(newFlows)` 即可刷新视图。
     */
    private _onDidChangeTreeData = new vscode.EventEmitter<SvfTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    // ============================================================
    // 【MOCK 数据 - 后续替换点】
    // 真实场景下，这里的 flows 应该来自 SVF CLI 的输出解析结果。
    // 接入方式参考：
    //   1. 在 svf.runAnalysis 命令里拿到 SVF 的 JSON / 文本输出
    //   2. 解析出 TaintFlow[]
    //   3. 调用 provider.refresh(taintFlows) 更新视图
    // ============================================================
    private flows: TaintFlow[] = [
        {
            id: 'flow-1',
            label: 'Taint Flow 1 (argv -> system)',
            steps: [
                { kind: 'source',      line: 10, description: 'Source: user input from argv' },
                { kind: 'propagation', line: 12, description: 'Propagation: assigned to local buffer' },
                { kind: 'propagation', line: 14, description: 'Propagation: passed to helper()' },
                { kind: 'sink',        line: 18, description: 'Sink: system(buffer) - command injection' }
            ]
        },
        {
            id: 'flow-2',
            label: 'Taint Flow 2 (recv -> strcpy)',
            steps: [
                { kind: 'source',      line: 23, description: 'Source: recv() from socket' },
                { kind: 'propagation', line: 25, description: 'Propagation: stored in struct field' },
                { kind: 'sink',        line: 30, description: 'Sink: strcpy() - buffer overflow' }
            ]
        }
    ];

    /** 用新的污点流数据刷新整棵树 */
    refresh(flows?: TaintFlow[]): void {
        if (flows) {
            this.flows = flows;
        }
        this._onDidChangeTreeData.fire();
    }

    /**
     * 把内部数据节点转换为 VS Code 可渲染的 TreeItem。
     * 这里负责：图标、折叠状态、点击命令绑定。
     */
    getTreeItem(element: SvfTreeNode): vscode.TreeItem {
        if (element.type === 'flow') {
            // 父节点：可折叠，默认展开
            const item = new vscode.TreeItem(
                element.flow.label,
                vscode.TreeItemCollapsibleState.Expanded
            );
            item.iconPath = new vscode.ThemeIcon('shield');
            item.contextValue = 'svfFlow';
            item.tooltip = `${element.flow.label} (${element.flow.steps.length} steps)`;
            return item;
        }

        // 子节点：叶子，点击触发跳转
        const step = element.step;
        const label = `${capitalize(step.kind)}: line ${step.line}`;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = step.description;            // 行尾灰色辅助说明
        item.tooltip = `${step.description}\n→ line ${step.line}`;
        item.iconPath = iconForKind(step.kind);
        item.contextValue = 'svfFlowStep';

        // 关键：点击节点时执行 svf.gotoLine 命令，参数顺序与下方注册保持一致
        item.command = {
            command: 'svf.gotoLine',
            title: 'Go to line',
            arguments: [step.line, step.file]
        };

        return item;
    }

    /**
     * 第一次调用时 element 为 undefined，需要返回根节点（所有 flow）。
     * 之后 VS Code 会带着具体的 flow 节点回调，要求返回它的子节点（steps）。
     */
    getChildren(element?: SvfTreeNode): vscode.ProviderResult<SvfTreeNode[]> {
        if (!element) {
            return this.flows.map(flow => ({ type: 'flow', flow } as SvfTreeNode));
        }
        if (element.type === 'flow') {
            return element.flow.steps.map(
                step => ({ type: 'step', step, parent: element.flow } as SvfTreeNode)
            );
        }
        return [];
    }
}

/** 工具：根据传播步类型返回不同主题图标 */
function iconForKind(kind: FlowStepKind): vscode.ThemeIcon {
    switch (kind) {
        case 'source':      return new vscode.ThemeIcon('debug-start');
        case 'propagation': return new vscode.ThemeIcon('arrow-right');
        case 'sink':        return new vscode.ThemeIcon('error');
    }
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * 注册侧边栏 Tree View，并注册 svf.gotoLine 跳转命令。
 * 在 activate() 里调用一次即可。
 */
export function registerSvfTreeView(context: vscode.ExtensionContext): void {
    const provider = new SvfFlowTreeProvider();

    // ① 把 provider 绑定到 package.json 中声明的视图 id
    //    注意：这里的 id 必须和 package.json 的 contributes.views[*].id 保持一致
    const treeView = vscode.window.createTreeView('svf-taint-flows', {
        treeDataProvider: provider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    // ② 注册点击跳转命令：把光标移到指定行，并把这一行滚动到屏幕中央
    const gotoDisposable = vscode.commands.registerCommand(
        'svf.gotoLine',
        async (line: number, filePath?: string) => {
            try {
                // 优先使用 step 自带的 file，否则回退到当前活动编辑器
                let document: vscode.TextDocument | undefined;
                if (filePath) {
                    document = await vscode.workspace.openTextDocument(filePath);
                } else if (vscode.window.activeTextEditor) {
                    document = vscode.window.activeTextEditor.document;
                } else {
                    vscode.window.showWarningMessage('SVF: 没有可跳转的目标文件。');
                    return;
                }

                const editor = await vscode.window.showTextDocument(document, {
                    preview: false
                });

                // VS Code 行号是 0-based，传入的 line 是 1-based
                const zeroLine = Math.max(0, line - 1);
                const safeLine = Math.min(zeroLine, Math.max(0, document.lineCount - 1));
                const targetLineText = document.lineAt(safeLine).text;

                // 选中整行第一个非空白字符的位置（让光标看起来更自然）
                const firstNonWs = targetLineText.search(/\S/);
                const col = firstNonWs >= 0 ? firstNonWs : 0;
                const position = new vscode.Position(safeLine, col);

                editor.selection = new vscode.Selection(position, position);

                // InCenter：把目标行滚动到可视区域中央
                editor.revealRange(
                    new vscode.Range(safeLine, 0, safeLine, targetLineText.length),
                    vscode.TextEditorRevealType.InCenter
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`SVF: 跳转失败 - ${msg}`);
            }
        }
    );
    context.subscriptions.push(gotoDisposable);
}
