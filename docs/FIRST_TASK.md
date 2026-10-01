# 第一次真实执行

网页创建会话并上传 examples/sample.csv，然后发送：

> 读取 input/sample.csv，用 Python 统计有效 value 的均值、缺失数量，以及按 site 分组的 PASS/FAIL 数量。脚本保存到 scripts/analyze.py 并真实执行；把结果写到 output/summary.csv 和 output/report.md。不要只给代码，请检查文件是否生成并报告路径。

第二轮发送：

> 修改刚才的脚本：排除 FAIL 行后重新计算 value 均值，并在报告里同时展示原始均值和过滤后的均值。真实重新执行，更新两个输出文件。

验收：有效 value 原始均值 110.84，PASS 行均值 100.95，缺失数量 1。打开真实产物核对，允许展示精度不同。SDK/runtime 初始化通过不等于这项业务验收通过。
