from openai import NotFoundError, OpenAI

# 直接在这里改测试配置即可
ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
ARK_API_KEY = "50c168b1-b3c1-498c-b7bd-ec37bd13f283"
ARK_MODEL = "doubao-1.5-vision-pro-250328"


def main() -> int:
    base_url = ARK_BASE_URL
    api_key = ARK_API_KEY
    model = ARK_MODEL

    if not api_key:
        raise RuntimeError("ARK_API_KEY is empty")

    if not model:
        raise RuntimeError("ARK_MODEL is empty")

    client = OpenAI(base_url=base_url, api_key=api_key)

    print("Testing Doubao vision model...")
    print(f"base_url: {base_url}")
    print(f"model:    {model}")

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "https://ark-project.tos-cn-beijing.ivolces.com/images/view.jpeg"
                            },
                        },
                        {"type": "text", "text": "请简短描述这张图片。"},
                    ],
                }
            ],
        )
    except NotFoundError as error:
        print("Model test failed: model or endpoint not found.")
        print(error)
        return 1
    except Exception as error:
        print("Model test failed with unexpected error:")
        print(error)
        return 1

    print("Model test succeeded.")
    if response.choices:
        message = response.choices[0].message
        print("assistant:")
        print(message.content)
    else:
        print("No choices returned.")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(error)
        raise SystemExit(1) from error
