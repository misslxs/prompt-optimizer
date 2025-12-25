import { ILLMService, Message, MessageContentPart, StreamHandlers, LLMResponse, ModelOption, ToolDefinition } from './types';
import type { TextModelConfig, ModelConfig } from '../model/types';
import { ModelManager } from '../model/manager';
import { APIError, RequestConfigError } from './errors';
import { isRunningInElectron } from '../../utils/environment';
import { ElectronLLMProxy } from './electron-proxy';
import type { ITextAdapterRegistry } from './types';
import { TextAdapterRegistry } from './adapters/registry';
import { mergeOverrides, splitOverridesBySchema } from '../model/parameter-utils';

/**
 * LLM服务实现 - 基于 Adapter 架构
 */
export class LLMService implements ILLMService {
  private registry: ITextAdapterRegistry;
  private readonly multimodalProviders = new Set([
    'openai',
    'openrouter',
    'deepseek',
    'zhipu',
    'siliconflow',
    'dashscope'
  ]);

  constructor(
    private modelManager: ModelManager,
    registry?: ITextAdapterRegistry
  ) {
    this.registry = registry ?? new TextAdapterRegistry();
  }

  /**
   * 验证消息格式
   */
  private validateMessages(messages: Message[], providerId?: string): void {
    if (!Array.isArray(messages)) {
      throw new RequestConfigError('消息必须是数组格式');
    }
    if (messages.length === 0) {
      throw new RequestConfigError('消息列表不能为空');
    }
    messages.forEach(msg => {
      if (!msg.role || !msg.content) {
        throw new RequestConfigError('消息格式无效: 缺少必要字段');
      }
      if (!['system', 'user', 'assistant', 'tool'].includes(msg.role)) {
        throw new RequestConfigError(`不支持的消息类型: ${msg.role}`);
      }
      if (typeof msg.content === 'string') {
        return;
      }
      if (!Array.isArray(msg.content) || msg.content.length === 0) {
        throw new RequestConfigError('消息内容必须是字符串或非空数组');
      }
      msg.content.forEach((part) => {
        if (!this.isValidContentPart(part)) {
          throw new RequestConfigError('消息内容包含无效的多模态片段');
        }
      });
    });

    if (providerId && this.hasImageContent(messages) && !this.multimodalProviders.has(providerId)) {
      throw new RequestConfigError('当前模型提供商暂不支持图片输入');
    }
  }

  private hasImageContent(messages: Message[]): boolean {
    return messages.some((msg) => Array.isArray(msg.content) && msg.content.some((part) => part.type === 'image_url'));
  }

  private isValidContentPart(part: MessageContentPart): boolean {
    if (!part || typeof part !== 'object' || !('type' in part)) return false;
    if (part.type === 'text') {
      return typeof part.text === 'string';
    }
    if (part.type === 'image_url') {
      return typeof part.image_url?.url === 'string';
    }
    return false;
  }

  /**
   * 验证模型配置
   */
  private validateModelConfig(modelConfig: TextModelConfig): void {
    if (!modelConfig) {
      throw new RequestConfigError('模型配置不能为空');
    }
    if (!modelConfig.providerMeta || !modelConfig.providerMeta.id) {
      throw new RequestConfigError('模型提供商元数据不能为空');
    }
    if (!modelConfig.modelMeta || !modelConfig.modelMeta.id) {
      throw new RequestConfigError('模型元数据不能为空');
    }
    if (!modelConfig.enabled) {
      throw new RequestConfigError('模型未启用');
    }
  }

  /**
   * 发送消息（结构化格式）
   */
  async sendMessageStructured(messages: Message[], provider: string): Promise<LLMResponse> {
    try {
      if (!provider) {
        throw new RequestConfigError('模型提供商不能为空');
      }

      const modelConfig = await this.modelManager.getModel(provider);
      if (!modelConfig) {
        throw new RequestConfigError(`模型 ${provider} 不存在`);
      }

      this.validateModelConfig(modelConfig);
      this.validateMessages(messages, modelConfig.providerMeta.id);

      console.log('发送消息:', {
        provider: modelConfig.providerMeta.id,
        model: modelConfig.modelMeta.id,
        messagesCount: messages.length
      });

      // 通过 Registry 获取 Adapter
      const adapter = this.registry.getAdapter(modelConfig.providerMeta.id);

      const runtimeConfig = this.prepareRuntimeConfig(modelConfig);

      // 使用 Adapter 发送消息
      return await adapter.sendMessage(messages, runtimeConfig);

    } catch (error: any) {
      if (error instanceof RequestConfigError || error instanceof APIError) {
        throw error;
      }
      throw new APIError(`发送消息失败: ${error.message}`);
    }
  }

  /**
   * 发送消息（传统格式，只返回主要内容）
   */
  async sendMessage(messages: Message[], provider: string): Promise<string> {
    const response = await this.sendMessageStructured(messages, provider);
    
    // 只返回主要内容，不包含推理内容
    // 如果需要推理内容，请使用 sendMessageStructured 方法
    return response.content;
  }

  /**
   * 发送消息（流式,支持结构化和传统格式）
   */
  async sendMessageStream(
    messages: Message[],
    provider: string,
    callbacks: StreamHandlers
  ): Promise<void> {
    try {
      console.log('开始流式请求:', { provider, messagesCount: messages.length });

      const modelConfig = await this.modelManager.getModel(provider);
      if (!modelConfig) {
        throw new RequestConfigError(`模型 ${provider} 不存在`);
      }

      this.validateModelConfig(modelConfig);
      this.validateMessages(messages, modelConfig.providerMeta.id);

      console.log('获取到模型实例:', {
        provider: modelConfig.providerMeta.id,
        model: modelConfig.modelMeta.id
      });

      // 通过 Registry 获取 Adapter
      const adapter = this.registry.getAdapter(modelConfig.providerMeta.id);

      const runtimeConfig = this.prepareRuntimeConfig(modelConfig);

      // 使用 Adapter 发送流式消息
      await adapter.sendMessageStream(messages, runtimeConfig, callbacks);

    } catch (error) {
      console.error('流式请求失败:', error);
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 发送消息（流式,支持工具调用）
   * 🆕 支持工具调用的流式消息发送
   */
  async sendMessageStreamWithTools(
    messages: Message[],
    provider: string,
    tools: ToolDefinition[],
    callbacks: StreamHandlers
  ): Promise<void> {
    try {
      console.log('开始带工具的流式请求:', {
        provider,
        messagesCount: messages.length,
        toolsCount: tools.length
      });

      const modelConfig = await this.modelManager.getModel(provider);
      if (!modelConfig) {
        throw new RequestConfigError(`模型 ${provider} 不存在`);
      }

      this.validateModelConfig(modelConfig);
      this.validateMessages(messages, modelConfig.providerMeta.id);

      console.log('获取到模型实例（带工具）:', {
        provider: modelConfig.providerMeta.id,
        model: modelConfig.modelMeta.id,
        tools: tools.map(t => t.function.name)
      });

      // 通过 Registry 获取 Adapter
      const adapter = this.registry.getAdapter(modelConfig.providerMeta.id);

      const runtimeConfig = this.prepareRuntimeConfig(modelConfig);

      // 使用 Adapter 发送带工具的流式消息
      await adapter.sendMessageStreamWithTools(messages, runtimeConfig, tools, callbacks);

    } catch (error) {
      console.error('带工具的流式请求失败:', error);
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }


  /**
   * 测试连接
   */
  async testConnection(provider: string): Promise<void> {
    try {
      if (!provider) {
        throw new RequestConfigError('模型提供商不能为空');
      }
      console.log('测试连接provider:', {
        provider: provider,
      });

      // 发送一个简单的测试消息
      const testMessages: Message[] = [
        {
          role: 'user',
          content: '请回答ok'
        }
      ];

      // 使用 sendMessage 进行测试
      await this.sendMessage(testMessages, provider);

    } catch (error: any) {
      if (error instanceof RequestConfigError || error instanceof APIError) {
        throw error;
      }
      throw new APIError(`连接测试失败: ${error.message}`);
    }
  }

  /**
   * 获取模型列表，以下拉选项格式返回
   * @param provider 提供商标识
   * @param customConfig 自定义配置（可选）
   */
  async fetchModelList(
    provider: string,
    customConfig?: Partial<TextModelConfig> | Partial<ModelConfig>
  ): Promise<ModelOption[]> {
    try {
      // 获取基础配置
      const baseConfig = await this.modelManager.getModel(provider);
      const modelConfig = await this.buildEffectiveModelConfig(provider, baseConfig, customConfig);

      console.log(`获取 ${modelConfig.name || provider} 的模型列表`);

      // 使用 Registry 获取模型列表
      const providerId = modelConfig.providerMeta.id;
      const models = await this.registry.getModels(providerId, modelConfig);

      // 转换为选项格式
      return models.map(model => ({
        value: model.id,
        label: model.name
      }));
    } catch (error: any) {
      console.error('获取模型列表失败:', error);
      if (error instanceof RequestConfigError || error instanceof APIError) {
        throw error;
      }
      throw new APIError(`获取模型列表失败: ${error.message}`);
    }
  }

  private prepareRuntimeConfig(modelConfig: TextModelConfig): TextModelConfig {
    const schema = modelConfig.modelMeta?.parameterDefinitions ?? [];

    // 合并参数：支持旧格式的 customParamOverrides（向后兼容）
    // 优先级：requestOverrides > customOverrides
    // requestOverrides 包含当前 paramOverrides（可能已合并或未合并）
    // customOverrides 确保旧数据的自定义参数不丢失
    const mergedOverrides = mergeOverrides({
      schema,
      includeDefaults: false,
      customOverrides: modelConfig.customParamOverrides,  // 🔧 兼容旧格式：自定义参数
      requestOverrides: modelConfig.paramOverrides        // 当前参数（包含内置 + 可能已合并的自定义）
    });

    return {
      ...modelConfig,
      paramOverrides: mergedOverrides
    };
  }

  /**
   * 构建用于获取模型列表的有效模型配置
   * 支持 TextModelConfig 与 传统 ModelConfig 两种输入结构
   */
  private async buildEffectiveModelConfig(
    provider: string,
    baseConfig?: TextModelConfig | null,
    customConfig?: Partial<TextModelConfig> | Partial<ModelConfig>
  ): Promise<TextModelConfig> {
    const customTextConfig = isTextConfigLike(customConfig) ? customConfig : undefined;
    const customLegacyConfig = isLegacyConfigLike(customConfig) ? customConfig : undefined;

    const providerId = (
      baseConfig?.providerMeta.id ??
      customTextConfig?.providerMeta?.id ??
      customLegacyConfig?.provider ??
      provider
    ).toLowerCase();

    const adapter = this.registry.getAdapter(providerId);
    const providerMeta = adapter.getProvider();

    const desiredModelId = (
      baseConfig?.modelMeta.id ??
      customTextConfig?.modelMeta?.id ??
      customLegacyConfig?.defaultModel ??
      adapter.getModels()[0]?.id ??
      providerMeta.id
    );

    let modelMeta = baseConfig?.modelMeta;
    if (!modelMeta || modelMeta.id !== desiredModelId) {
      modelMeta = adapter.getModels().find(model => model.id === desiredModelId);
      if (!modelMeta) {
        modelMeta = adapter.buildDefaultModel(desiredModelId);
      }
    }

    const connectionConfig = {
      ...(baseConfig?.connectionConfig ?? {}),
      ...(customTextConfig?.connectionConfig ?? {})
    };

    if (customLegacyConfig?.apiKey) {
      connectionConfig.apiKey = customLegacyConfig.apiKey;
    }
    if (customLegacyConfig?.baseURL) {
      connectionConfig.baseURL = customLegacyConfig.baseURL;
    }
    if (!connectionConfig.baseURL && providerMeta.defaultBaseURL) {
      connectionConfig.baseURL = providerMeta.defaultBaseURL;
    }

    const schema = modelMeta.parameterDefinitions ?? [];
    const legacySplit = splitOverridesBySchema(schema, customLegacyConfig?.llmParams ?? {});
    const combinedBuiltIn = {
      ...(baseConfig?.paramOverrides ?? {}),
      ...(customTextConfig?.paramOverrides ?? {}),
      ...legacySplit.builtIn
    };
    const combinedCustom = {
      ...(baseConfig?.customParamOverrides ?? {}),
      ...(customTextConfig?.customParamOverrides ?? {}),
      ...legacySplit.custom
    };

    return {
      id: baseConfig?.id ?? provider,
      name: customTextConfig?.name ?? customLegacyConfig?.name ?? baseConfig?.name ?? providerMeta.name,
      enabled: baseConfig?.enabled ?? (customTextConfig?.enabled ?? true),
      providerMeta,
      modelMeta,
      connectionConfig,
      paramOverrides: combinedBuiltIn,
      customParamOverrides: combinedCustom
    };
  }

}

/**
 * 创建LLM服务实例的工厂函数
 * @param modelManager 模型管理器实例
 * @returns LLM服务实例
 */
export function createLLMService(modelManager: ModelManager): ILLMService {
  // 在Electron环境中，返回代理实例
  if (isRunningInElectron()) {
    console.log('[LLM Service Factory] Electron environment detected, using proxy.');
    return new ElectronLLMProxy();
  }

  // 创建 Registry 实例
  const registry = new TextAdapterRegistry();

  // 返回注入了 Registry 的 LLMService 实例
  return new LLMService(modelManager, registry);
}

// eslint-disable-next-line @typescript-eslint/ban-types
type LegacyLike = Partial<ModelConfig> & {}

/**
 * 辅助方法: 判断是否为TextModelConfig结构
 */
function isTextConfigLike(config?: Partial<TextModelConfig> | Partial<ModelConfig>): config is Partial<TextModelConfig> {
  return !!config && typeof config === 'object' && 'providerMeta' in config;
}

/**
 * 辅助方法: 判断是否为传统ModelConfig结构
 */
function isLegacyConfigLike(config?: Partial<TextModelConfig> | Partial<ModelConfig>): config is LegacyLike {
  return !!config && typeof config === 'object' && (
    'provider' in config || 'defaultModel' in config || 'baseURL' in config
  );
}
