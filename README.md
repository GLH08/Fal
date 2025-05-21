# Fal.ai Imagen4 OpenAI-Compatible Cloudflare Worker

这是一个 Cloudflare Worker 脚本，它充当 Fal.ai Imagen4 图像生成模型的代理，并提供与 OpenAI API 兼容的接口。这使得您可以将 Fal.ai Imagen4 集成到期望 OpenAI API 格式的应用程序或服务中，例如各种聊天机器人客户端。

## ✨ 功能特性

*   **OpenAI API 兼容性**:
    *   支持 `/v1/images/generations` 端点用于直接图像生成。
    *   支持 `/v1/chat/completions` 端点，允许通过聊天交互生成图像（支持流式和非流式响应）。
    *   支持 `/v1/models` 端点，列出可用的模型（当前为 `imagen4-preview`）。
*   **Fal.ai Imagen4 集成**: 在后端使用 Fal.ai 的 `imagen4-preview` 模型进行图像生成。
*   **灵活的尺寸/比例控制**:
    *   可以直接在 `/v1/images/generations` 请求的 `size` 参数中指定。
    *   可以在 `/v1/chat/completions` 请求的 `size` 参数中指定。
    *   **智能识别聊天内容中的尺寸**: Worker 可以从用户发送的聊天消息文本中自动提取尺寸或宽高比信息（例如 "画一只猫 9:16" 或 "城市风景 size:1024x768"）。
*   **Worker 访问密钥验证**: 通过 `Authorization: Bearer YOUR_WORKER_ACCESS_KEY` HTTP 头保护 Worker 端点，确保只有授权用户才能调用。
*   **流式响应**: 对于 `/v1/chat/completions` 端点，支持流式响应，可以逐步显示生成过程和结果。

## 🚀 部署与配置

### 先决条件

1.  一个 **Cloudflare 账户**。
2.  一个 **Fal.ai 账户** 并获取您的 API 密钥。

### 部署步骤

1.  登录到您的 Cloudflare 仪表板。
2.  导航到 "Workers & Pages"。
3.  点击 "创建应用程序" -> "创建 Worker"。
4.  为您的 Worker 指定一个名称（例如 `fal-imagen4-proxy`）。
5.  点击 "部署"。
6.  部署完成后，点击 "编辑代码"。
7.  将提供的 `worker.js` (即您收到的完整脚本) 的内容复制并粘贴到 Cloudflare Worker 编辑器中，替换掉默认的代码。
8.  点击 "部署" 以保存并部署您的代码。

### 环境变量配置

部署代码后，您**必须**在 Worker 的设置中配置以下环境变量：

1.  `FAL_API_KEY`:
    *   **值**: 您的 Fal.ai API 密钥。
    *   **路径**: 在 Worker 设置页面 -> "变量" -> "环境变量" -> "添加变量"。
2.  `WORKER_ACCESS_KEY`:
    *   **值**: 您自定义的一个强密钥，用于保护对此 Worker 的访问（例如，一个随机生成的字符串，如 `sk-mysecretworkerkey123abc`）。
    *   **路径**: 在 Worker 设置页面 -> "变量" -> "环境变量" -> "添加变量"。

**重要**: 确保将这些变量标记为“秘密”（如果 Cloudflare 界面提供该选项），以增强安全性。

## 🛠️ 如何使用

部署并配置好 Worker 后，您可以通过其公共 URL（例如 `https://your-worker-name.your-subdomain.workers.dev`）与它进行交互。

### 通用要求

所有 API 请求都必须包含 `Authorization` HTTP 头：

`Authorization: Bearer YOUR_WORKER_ACCESS_KEY`


将 `YOUR_WORKER_ACCESS_KEY` 替换为您在环境变量中设置的实际 Worker 访问密钥。

### 1. 列出模型 (`/v1/models`)

*   **方法**: `GET`
*   **URL**: `https://<您的Worker地址>/v1/models`
*   **响应**:
    ```json
    {
      "object": "list",
      "data": [
        {
          "id": "imagen4-preview",
          "object": "model",
          "created": 1677652288, // 示例时间戳
          "owned_by": "fal-ai",
          "permission": [],
          "root": "imagen4-preview",
          "parent": null
        }
      ]
    }
    ```

### 2. 生成图像 (`/v1/images/generations`)

*   **方法**: `POST`
*   **URL**: `https://<您的Worker地址>/v1/images/generations`
*   **请求体 (JSON)**:
    ```json
    {
      "prompt": "一只穿着宇航服的可爱猫咪在月球上喝咖啡",
      "n": 1, // 生成图片数量 (Fal.ai Imagen4 支持 1-4)
      "size": "16:9", // 图片尺寸/比例，例如 "1024x1024", "16:9", "9:16", "4:3", "3:4"
      "response_format": "url" // "url" 或 "b64_json"
    }
    ```
*   **响应 (示例, `response_format: "url"`)**:
    ```json
    {
      "created": 1677652288,
      "data": [
        {
          "url": "https://fal.media/files/..." // 生成的图片URL
        }
      ]
    }
    ```

### 3. 通过聊天生成图像 (`/v1/chat/completions`)

此端点模拟 OpenAI 的聊天接口，但用于生成图像。

*   **方法**: `POST`
*   **URL**: `https://<您的Worker地址>/v1/chat/completions`
*   **请求体 (JSON)**:

    **示例 1: 在 JSON 中指定尺寸**
    ```json
    {
      "model": "imagen4-preview",
      "messages": [
        {
          "role": "user",
          "content": "画一幅赛博朋克风格的城市夜景"
        }
      ],
      "size": "9:16", // 在这里指定尺寸
      "stream": false // true 表示流式响应, false 表示一次性响应
    }
    ```

    **示例 2: 在聊天内容中指定尺寸 (Worker 会自动提取)**
    ```json
    {
      "model": "imagen4-preview",
      "messages": [
        {
          "role": "user",
          "content": "画一幅赛博朋克风格的城市夜景 比例:16:9" // 尺寸指令在文本中
        }
      ],
      "stream": true
    }
    ```
    支持的聊天内容中的尺寸指令格式包括：
    *   `size:9:16` (半角/全角冒号)
    *   `比例=16/9`
    *   `aspect_ratio 1024x768`
    *   直接的比例或尺寸，如 `9:16` 或 `1024x1024` (如果文本中没有其他数字干扰)

*   **响应 (非流式, 示例)**:
    ```json
    {
      "id": "chatcmpl-...",
      "object": "chat.completion",
      "created": 1677652288,
      "model": "imagen4-preview",
      "choices": [
        {
          "index": 0,
          "message": {
            "role": "assistant",
            "content": "Generated image with prompt: \"画一幅赛博朋克风格的城市夜景\" and aspect ratio: 16:9\n\n![Generated Image](https://fal.media/files/...)"
          },
          "finish_reason": "stop"
        }
      ],
      "usage": { ... }
    }
    ```
*   **响应 (流式)**: 将会是一系列 `text/event-stream` 事件，逐步显示生成状态和最终的图片 Markdown。

## ⚙️ 模型

此 Worker 当前硬编码使用 Fal.ai 的 `imagen4-preview` 模型。

## ⚠️ 重要提示

*   **API 密钥安全**: 您的 `FAL_API_KEY` 和 `WORKER_ACCESS_KEY` 都非常敏感。请务必将它们存储为 Cloudflare Worker 的环境变量，并且不要将它们硬编码到公开的代码库中或直接暴露给客户端。
*   **错误处理**: Worker 会尝试返回符合 OpenAI API 格式的错误响应。
*   **尺寸识别的局限性**: 虽然 Worker 努力从聊天文本中识别尺寸，但过于复杂或模糊的表述可能无法被正确解析。在这些情况下，建议通过 API 请求体中的 `size` 参数明确指定。

---

希望这份文档能帮助您成功部署和使用这个 Cloudflare Worker！
