#include <stdio.h>
#include <stdlib.h>
#include <string.h>
// #include <sys/socket.h>

void helper(char *buffer);
void process_network(int sock);

int main(int argc, char *argv[]) {
    char *user_input = argv[1];                 // [第10行] Source 1: 获取外部不受信任的输入
    char local_buffer[256];
    strcpy(local_buffer, user_input);           // [第12行] Propagation 1: 污点数据拷贝到本地
    printf("Starting execution...\n");
    helper(local_buffer);                       // [第14行] Propagation 2: 污点数据作为参数传递
    process_network(0);
    return 0;
}
void helper(char *buf) { system(buf); }         // [第18行] Sink 1: 危险函数执行！命令注入漏洞

struct NetworkData { char field[50]; };

void process_network(int sock) {
    char recv_buf[1024]; recv(sock, recv_buf, 1024, 0); // [第23行] Source 2: 从网络端口接收数据
    struct NetworkData data;
    memcpy(data.field, recv_buf, 50);           // [第25行] Propagation: 存储到结构体字段中
    
    // Simulate some complex logic here
    printf("Parsing network packet...\n");
    char dest[20];
    strcpy(dest, data.field);                   // [第30行] Sink 2: 危险函数拷贝！典型的缓冲区溢出漏洞
}

// ==========================================
// ⬇️ 下方为填充代码，目的是增加文件长度
// 这样你在点击 TreeView 时，才能感受到 VS Code
// 自动上下滚动并把目标代码居中的丝滑效果
// ==========================================

void dummy_function_1() {
    int a = 0;
    for(int i = 0; i < 100; i++) {
        a += i;
    }
    printf("Result A: %d\n", a);
}

void dummy_function_2() {
    char *dummy_ptr = (char *)malloc(1024);
    if(dummy_ptr != NULL) {
        memset(dummy_ptr, 0, 1024);
        free(dummy_ptr);
    }
}

void dummy_function_3() {
    // Just some more lines to scroll
    printf("System stable.\n");
    printf("No other issues found.\n");
}

// 到底啦！现在去点击左侧的盾牌图标测试吧！