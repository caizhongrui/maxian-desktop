/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具调用格式说明
 * 仅保留XML格式规范（batch使用规则已移至toolUseGuidelines）
 */
export function getToolUseSection(): string {
	return `====

TOOL USE

你可以使用一组工具来完成任务，工具需要用户批准后才会执行。

- 优先使用运行环境提供的原生工具调用能力
- 只有在当前模型/环境无法使用原生工具调用时，才退回到 XML 形式
- 不要为了满足流程而强行调用工具；最终回答、总结或说明阻塞时可以直接输出文本

# 工具使用格式

当需要使用 XML 回退格式时，**工具的实际名称**作为 XML 标签名，**工具的实际参数名**作为子标签名，参数值写在子标签内。

示例（读取文件）：
<read_file>
<path>src/main/java/com/example/UserController.java</path>
</read_file>

示例（精确替换，主力编辑工具）：
<edit>
<path>src/main/java/com/example/UserService.java</path>
<old_string>    public void saveUser(User user) {
        userRepo.save(user);
    }</old_string>
<new_string>    public User saveUser(User user) {
        return userRepo.save(user);
    }</new_string>
</edit>

示例（执行命令）：
<execute_command>
<command>npm run build</command>
<requires_approval>false</requires_approval>
</execute_command>

**重要**：使用回退 XML 格式时，必须使用工具的真实名称和真实参数名，绝不能使用占位符。参数值可以是多行文本。`;
}
