from openai import OpenAI

# API_KEY = "sk-H4Gg7SY4ml7JPTi5hT3SXukgQ8KdmqBOFeymMVnq3LMpZlRm"
# BASE_URL = "https://api.moonshot.cn/v1"
# MODEL = "kimi-k2.5"

API_KEY = ""
BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
MODEL = "gemini-2.5-flash"

def main():
    client = OpenAI(
        api_key=API_KEY,
        base_url=BASE_URL,
    )

    print(f"base_url: {BASE_URL}")
    print(f"model:    {MODEL}")

    response = client.chat.completions.create(
        model=MODEL,
        # thinking={"type": "disabled"},
        reasoning_effort="low",
        messages=[
            {"role": "system", "content": "你是一个大模型，一个有帮助的助手。"},
            {"role": "user", "content": "你好，请简单介绍一下自己。"},
        ],
        
    )

    print(response.choices[0].message.content)


if __name__ == "__main__":
    main()


# from openai import OpenAI

# client = OpenAI(
#     api_key="GEMINI_API_KEY",
#     base_url="https://generativelanguage.googleapis.com/v1beta/openai/"
# )

# response = client.chat.completions.create(
#     model="gemini-3-flash-preview",
#     reasoning_effort="low",
#     messages=[
#         {   "role": "system",
#             "content": "You are a helpful assistant."
#         },
#         {
#             "role": "user",
#             "content": "Explain to me how AI works"
#         }
#     ]
# )

# print(response.choices[0].message)
